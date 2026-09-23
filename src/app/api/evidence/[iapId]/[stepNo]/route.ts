import { revalidatePath } from "next/cache";
import { appendEvidenceLinks, readItems } from "@/data/tracker-repository";
import { todayInJakarta } from "@/domain/dates";
import type { EvidenceKind } from "@/domain/evidence-file";
import type { DerivedActionItem, ItemKey } from "@/domain/types";
import {
  completeEvidenceUpload,
  deleteEvidenceFile,
  evidenceUploadStatus,
  startEvidenceUploadSession,
  validateEvidenceFile,
  type EvidenceUploadMetadata,
} from "@/drive/evidence";
import { canAccessCase } from "@/lib/case-access";
import { sameOrigin } from "@/lib/security";
import { isMemoryTransport } from "@/sheets";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ iapId: string; stepNo: string }>;
};

interface UploadTarget {
  stepNos: number[];
  keys: ItemKey[];
  items: DerivedActionItem[];
}

export async function POST(request: Request, context: RouteContext) {
  const unavailable = uploadAvailabilityError(request);
  if (unavailable) return unavailable;

  try {
    const body: unknown = await request.json();
    const parsed = parseInitiateBody(body);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const target = await resolveTarget(context, parsed.stepNos);
    if (target instanceof Response) return target;
    const primaryItem = target.items[0]!;
    const validationError = validateEvidenceFile(parsed.file, parsed.kind);
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 });
    }

    const session = await startEvidenceUploadSession(
      parsed.file,
      parsed.kind,
      target.keys[0]!,
      {
        station: primaryItem.station,
        date: primaryItem.targetDate || todayInJakarta(),
      },
      target.stepNos,
      request.headers.get("origin")!,
    );
    return Response.json(session);
  } catch (error) {
    console.error("Evidence upload session failed", error);
    return uploadFailure(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const unavailable = uploadAvailabilityError(request);
  if (unavailable) return unavailable;

  try {
    const body: unknown = await request.json();
    const parsed = parseCompleteBody(body);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const target = await resolveTarget(context, parsed.stepNos);
    if (target instanceof Response) return target;
    const uploaded = await completeEvidenceUpload(
      parsed.fileId,
      parsed.nonce,
      parsed.kind,
      target.keys[0]!,
      target.stepNos,
    );
    const saved = await appendEvidenceLinks(target.keys, uploaded.webViewLink);
    if (!saved.ok) {
      if (!uploaded.reused) {
        try {
          await deleteEvidenceFile(uploaded.fileId);
        } catch (rollbackError) {
          console.error(
            `Failed to roll back orphaned evidence file ${uploaded.fileId}`,
            rollbackError,
          );
        }
      }
      return Response.json(
        { error: Object.values(saved.errors)[0] ?? "Gagal menyimpan link evidence." },
        { status: 404 },
      );
    }

    revalidatePath("/");
    return Response.json({
      url: uploaded.webViewLink,
      name: parsed.originalName,
      stepNos: target.stepNos,
    });
  } catch (error) {
    console.error("Evidence upload completion failed", error);
    return uploadFailure(error);
  }
}

function uploadAvailabilityError(request: Request): Response | null {
  if (!sameOrigin(request)) {
    return Response.json({ error: "Permintaan upload tidak valid." }, { status: 403 });
  }
  if (isMemoryTransport()) {
    return Response.json(
      { error: "Upload Google Drive tidak tersedia pada mode data offline." },
      { status: 503 },
    );
  }
  const status = evidenceUploadStatus();
  if (!status.ready) {
    console.error(
      `Evidence upload is not configured on this deployment. Missing: ${status.missing.join(", ")}`,
    );
    return Response.json(
      {
        error:
          "Upload file belum aktif di server ini karena koneksi Google Drive belum dikonfigurasi. Gunakan pilihan Link Evidence untuk sementara, dan minta admin melengkapi konfigurasi Google Drive.",
      },
      { status: 503 },
    );
  }
  return null;
}

async function resolveTarget(
  context: RouteContext,
  requestedStepNos: number[] | undefined,
): Promise<UploadTarget | Response> {
  const { iapId, stepNo: rawStepNo } = await context.params;
  const stepNo = Number(rawStepNo);
  if (!iapId.trim() || !Number.isInteger(stepNo) || stepNo < 1) {
    return Response.json({ error: "Identitas item evidence tidak valid." }, { status: 400 });
  }
  const stepNos = parseStepNos(requestedStepNos, stepNo);
  if (!stepNos) {
    return Response.json(
      { error: "Daftar langkah tujuan evidence tidak valid." },
      { status: 400 },
    );
  }

  let read: ReturnType<typeof readItems> | undefined;
  const trackerItems = () => (read ??= readItems());
  if (!(await canAccessCase(iapId, trackerItems))) {
    return Response.json(
      { error: "Anda tidak memiliki akses ke kasus ini." },
      { status: 403 },
    );
  }

  const keys = stepNos.map((targetStepNo) => ({ iapId, stepNo: targetStepNo }));
  const allItems = await trackerItems();
  const items = keys.map((key) =>
    allItems.find(
      (candidate) => candidate.iapId === key.iapId && candidate.stepNo === key.stepNo,
    ),
  );
  const missingIndex = items.findIndex((item) => !item);
  if (missingIndex >= 0) {
    const missing = keys[missingIndex]!;
    return Response.json(
      { error: `Item ${missing.iapId} langkah ${missing.stepNo} tidak ditemukan.` },
      { status: 404 },
    );
  }

  return { stepNos, keys, items: items as DerivedActionItem[] };
}

function parseStepNos(value: unknown, fallback: number): number[] | null {
  if (value === undefined) return [fallback];
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const unique = [...new Set(value)];
  if (
    unique.some(
      (candidate) =>
        typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 1,
    )
  ) {
    return null;
  }
  return (unique as number[]).sort((a, b) => a - b);
}

function parseInitiateBody(body: unknown):
  | { ok: true; kind: EvidenceKind; file: EvidenceUploadMetadata; stepNos?: number[] }
  | { ok: false; error: string } {
  if (!isRecord(body) || (body.kind !== "photo" && body.kind !== "document")) {
    return { ok: false, error: "Jenis evidence tidak valid." };
  }
  if ("stepNos" in body && body.stepNos !== undefined && !Array.isArray(body.stepNos)) {
    return { ok: false, error: "Daftar langkah tujuan evidence tidak valid." };
  }
  if (!isRecord(body.file)) {
    return { ok: false, error: "Pilih file evidence terlebih dahulu." };
  }
  const { name, type, size } = body.file;
  if (
    typeof name !== "string" || !name.trim() || name.length > 255 ||
    typeof type !== "string" || type.length > 200 ||
    typeof size !== "number" || !Number.isSafeInteger(size)
  ) {
    return { ok: false, error: "Metadata file evidence tidak valid." };
  }
  return {
    ok: true,
    kind: body.kind,
    file: { name, type, size },
    stepNos: Array.isArray(body.stepNos) ? body.stepNos as number[] : undefined,
  };
}

function parseCompleteBody(body: unknown):
  | {
      ok: true;
      fileId: string;
      nonce: string;
      kind: EvidenceKind;
      originalName: string;
      stepNos?: number[];
    }
  | { ok: false; error: string } {
  if (!isRecord(body) || (body.kind !== "photo" && body.kind !== "document")) {
    return { ok: false, error: "Jenis evidence tidak valid." };
  }
  if ("stepNos" in body && body.stepNos !== undefined && !Array.isArray(body.stepNos)) {
    return { ok: false, error: "Daftar langkah tujuan evidence tidak valid." };
  }
  if (
    typeof body.fileId !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(body.fileId) ||
    typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(body.nonce) ||
    typeof body.originalName !== "string" || !body.originalName.trim() || body.originalName.length > 255
  ) {
    return { ok: false, error: "Konfirmasi upload evidence tidak valid." };
  }
  return {
    ok: true,
    fileId: body.fileId,
    nonce: body.nonce,
    kind: body.kind,
    originalName: body.originalName,
    stepNos: Array.isArray(body.stepNos) ? body.stepNos as number[] : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uploadFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const userSafe = [
    /^Otorisasi Google Drive/,
    /^Konfigurasi OAuth Google Drive/,
    /^Kuota penyimpanan/,
    /^Google Drive tidak merespons/,
    /^Sesi upload evidence/,
    /^Ukuran file evidence/,
    /^Isi file tidak sesuai/,
  ].some((pattern) => pattern.test(message));
  return Response.json(
    {
      error: userSafe
        ? message
        : "Gagal mengunggah evidence. Silakan coba lagi atau hubungi admin.",
    },
    { status: 500 },
  );
}
