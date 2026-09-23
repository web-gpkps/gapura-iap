import {
  matchesEvidenceFileSignature,
  validateEvidenceMetadata,
  type EvidenceKind,
} from "@/domain/evidence-file";
import { readUploadResponse } from "@/lib/upload-response";

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

interface UploadSessionResponse {
  sessionUrl?: string;
  nonce?: string;
  error?: string;
}

interface CompletedUploadResponse {
  url?: string;
  name?: string;
  error?: string;
}

export interface UploadEvidenceOptions {
  endpoint: string;
  file: File;
  kind: EvidenceKind;
  stepNos?: readonly number[];
  onProgress?: (percent: number) => void;
}

export async function uploadEvidence({
  endpoint,
  file,
  kind,
  stepNos,
  onProgress,
}: UploadEvidenceOptions): Promise<{ url: string; name: string }> {
  const validationError = validateEvidenceMetadata(file, kind);
  if (validationError) throw new Error(validationError);
  if (!(await matchesEvidenceFileSignature(file))) {
    throw new Error("Isi file tidak sesuai dengan format evidence.");
  }

  let sessionResponse: Response;
  try {
    sessionResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        file: { name: file.name, type: file.type, size: file.size },
        stepNos,
      }),
    });
  } catch {
    throw new Error("Tidak dapat menghubungi server untuk memulai upload evidence.");
  }
  const session = await readUploadResponse<UploadSessionResponse>(sessionResponse);
  if (!sessionResponse.ok || !session.sessionUrl || !session.nonce) {
    throw new Error(session.error || "Gagal memulai upload evidence.");
  }

  const fileId = await uploadFileToDrive(
    session.sessionUrl,
    file,
    onProgress,
  );
  let completeResponse: Response;
  try {
    completeResponse = await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId,
        nonce: session.nonce,
        kind,
        originalName: file.name,
        stepNos,
      }),
    });
  } catch {
    throw new Error(
      "File sudah terkirim ke Google Drive, tetapi server tidak dapat menyimpan link-nya. Coba lagi setelah koneksi stabil.",
    );
  }
  const completed = await readUploadResponse<CompletedUploadResponse>(completeResponse);
  if (!completeResponse.ok || !completed.url) {
    throw new Error(completed.error || "Gagal menyimpan link evidence.");
  }
  onProgress?.(100);
  return { url: completed.url, name: completed.name || file.name };
}

async function uploadFileToDrive(
  sessionUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<string> {
  let offset = 0;
  while (offset < file.size) {
    const endExclusive = Math.min(offset + CHUNK_BYTES, file.size);
    const response = await putChunkWithRetry(
      sessionUrl,
      file.slice(offset, endExclusive),
      offset,
      endExclusive - 1,
      file.size,
    );

    if (response.status === 200 || response.status === 201) {
      const result = await driveJson(response);
      if (!result.id) throw new Error("Google Drive tidak mengembalikan ID file.");
      onProgress?.(100);
      return result.id;
    }
    if (response.status !== 308) throw await driveUploadError(response);

    const accepted = acceptedOffset(response.headers.get("range"));
    offset = accepted === null ? endExclusive : Math.max(endExclusive, accepted);
    onProgress?.(Math.min(99, Math.round((offset / file.size) * 100)));
  }
  throw new Error("Google Drive belum menyelesaikan upload evidence.");
}

async function putChunkWithRetry(
  sessionUrl: string,
  chunk: Blob,
  start: number,
  end: number,
  total: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Range": `bytes ${start}-${end}/${total}`,
        },
        body: chunk,
      });
      if (response.status < 500 || attempt === MAX_ATTEMPTS) return response;
      lastError = new Error(`Google Drive sementara bermasalah (${response.status}).`);
    } catch (error) {
      lastError = error;
    }
    await delay(400 * attempt);
  }
  throw new Error(
    "Browser tidak dapat mengirim file ke Google Drive. Muat ulang halaman lalu coba lagi.",
    { cause: lastError },
  );
}

function acceptedOffset(range: string | null): number | null {
  const match = range?.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : null;
}

async function driveJson(response: Response): Promise<{ id?: string }> {
  try {
    return await response.json() as { id?: string };
  } catch {
    throw new Error("Respons Google Drive tidak valid.");
  }
}

async function driveUploadError(response: Response): Promise<Error> {
  const body = await response.text();
  if (response.status === 410 || response.status === 404) {
    return new Error("Sesi upload Google Drive sudah berakhir. Pilih file dan coba lagi.");
  }
  return new Error(
    body && body.length < 300
      ? `Google Drive menolak upload (${response.status}): ${body}`
      : `Google Drive menolak upload (${response.status}).`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
