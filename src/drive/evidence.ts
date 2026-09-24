import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { auth, drive as driveApi, type drive_v3 } from "@googleapis/drive";
import {
  evidenceFileName,
  viewOnlyLink,
  type EvidenceFileIdentity,
} from "@/domain/evidence";
import {
  evidenceFileExtension,
  evidenceMimeType,
  matchesEvidenceSignature,
  MAX_EVIDENCE_BYTES,
  validateEvidenceMetadata,
  type EvidenceKind,
} from "@/domain/evidence-file";
import type { ItemKey } from "@/domain/types";
import { evidenceDriveFolderId } from "@/sheets/config";

export { evidenceUploadStatus } from "@/drive/evidence-config";
export { MAX_EVIDENCE_BYTES } from "@/domain/evidence-file";
export type { EvidenceKind } from "@/domain/evidence-file";

export interface EvidenceUploadMetadata {
  name: string;
  type: string;
  size: number;
}

export interface EvidenceUploadSession {
  sessionUrl: string;
  nonce: string;
  fileName: string;
  mimeType: string;
}

export interface UploadedEvidence {
  fileId: string;
  webViewLink: string;
  reused: boolean;
}

const DRIVE_TIMEOUT_MS = 60_000;
const driveTimeout = { timeout: DRIVE_TIMEOUT_MS };
const EVIDENCE_HASH_PROPERTY = "iapEvidenceHash";
const UPLOAD_NONCE_PROPERTY = "iapUploadNonce";
const UPLOAD_TARGET_PROPERTY = "iapUploadTarget";
const UPLOAD_PENDING_PROPERTY = "iapUploadPending";
const SAMPLE_BYTES = 1024 * 1024;

let cachedAuth: { key: string; client: InstanceType<typeof auth.OAuth2> } | undefined;

/** My Drive uploads run as the folder owner so files use that account's quota. */
function evidenceAuth() {
  const clientId = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN?.trim();
  const values = [clientId, clientSecret, refreshToken];

  if (values.some((value) => value && /^(ISI_|your_|change_me|xxx)/i.test(value))) {
    throw new Error(
      "Konfigurasi OAuth Google Drive masih berisi placeholder. Gunakan Client ID, Client Secret, dan Refresh Token yang asli.",
    );
  }
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Konfigurasi OAuth Google Drive belum lengkap. Isi GOOGLE_DRIVE_OAUTH_CLIENT_ID, GOOGLE_DRIVE_OAUTH_CLIENT_SECRET, dan GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN.",
    );
  }

  // Reused across requests on a warm instance so the access token (valid ~1h) is
  // refreshed once, not on every upload call. The library dedupes concurrent refreshes.
  const cacheKey = `${clientId}\0${clientSecret}\0${refreshToken}`;
  if (cachedAuth?.key !== cacheKey) {
    const client = new auth.OAuth2(clientId, clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    cachedAuth = { key: cacheKey, client };
  }
  return cachedAuth.client;
}

export function validateEvidenceFile(
  file: EvidenceUploadMetadata,
  kind: EvidenceKind,
): string | null {
  return validateEvidenceMetadata(file, kind);
}

function targetFingerprint(key: ItemKey, stepNos: readonly number[]): string {
  return createHash("sha256")
    .update(`${key.iapId}\0${[...stepNos].sort((a, b) => a - b).join(",")}`)
    .digest("hex");
}

function evidenceFingerprint(key: ItemKey, fileName: string, md5Checksum: string): string {
  return createHash("sha256")
    .update(`${key.iapId}\0${key.stepNo}\0${fileName}\0md5:${md5Checksum}`)
    .digest("hex");
}

async function accessToken(client: ReturnType<typeof evidenceAuth>): Promise<string> {
  try {
    const result = await client.getAccessToken();
    if (!result.token) throw new Error("Google Drive tidak mengembalikan access token.");
    return result.token;
  } catch (error) {
    throw driveFriendlyError(error);
  }
}

/** Starts a resumable upload; the file bytes never pass through Vercel. */
export async function startEvidenceUploadSession(
  file: EvidenceUploadMetadata,
  kind: EvidenceKind,
  key: ItemKey,
  identity: EvidenceFileIdentity,
  stepNos: readonly number[],
  browserOrigin: string,
): Promise<EvidenceUploadSession> {
  const validationError = validateEvidenceFile(file, kind);
  if (validationError) throw new Error(validationError);

  const client = evidenceAuth();
  const token = await accessToken(client);
  const fileName = evidenceFileName(file.name, key, identity);
  const mimeType = evidenceMimeType(file);
  const nonce = randomBytes(24).toString("base64url");
  const target = targetFingerprint(key, stepNos);
  const uploadOrigin = new URL(browserOrigin).origin;
  const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
  url.searchParams.set("uploadType", "resumable");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        // Drive uses the initiating origin when allowing the browser's later PUT
        // to this resumable session. Without it, the upload succeeds in server
        // tools but the browser sees only a CORS-level "Failed to fetch".
        Origin: uploadOrigin,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(file.size),
      },
      body: JSON.stringify({
        name: fileName,
        mimeType,
        parents: [evidenceDriveFolderId()],
        appProperties: {
          [UPLOAD_NONCE_PROPERTY]: nonce,
          [UPLOAD_TARGET_PROPERTY]: target,
          [UPLOAD_PENDING_PROPERTY]: "true",
        },
      }),
      signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
    });
  } catch (error) {
    throw driveFriendlyError(error);
  }

  if (!response.ok) throw await driveResponseError(response);
  const sessionUrl = response.headers.get("location");
  if (!sessionUrl) {
    throw new Error("Google Drive tidak mengembalikan alamat sesi upload.");
  }
  return { sessionUrl, nonce, fileName, mimeType };
}

/** Verifies and adopts a browser-completed Drive upload before it reaches column Q. */
export async function completeEvidenceUpload(
  fileId: string,
  nonce: string,
  kind: EvidenceKind,
  key: ItemKey,
  stepNos: readonly number[],
): Promise<UploadedEvidence> {
  const client = evidenceAuth();
  const drive = driveApi({ version: "v3", auth: client });
  const found = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields: "id,name,mimeType,size,md5Checksum,webViewLink,parents,appProperties,createdTime",
  }, driveTimeout);
  const file = found.data;
  const properties = file.appProperties ?? {};
  const size = Number(file.size);
  const expectedTarget = targetFingerprint(key, stepNos);

  if (
    !file.id ||
    properties[UPLOAD_NONCE_PROPERTY] !== nonce ||
    properties[UPLOAD_TARGET_PROPERTY] !== expectedTarget ||
    properties[UPLOAD_PENDING_PROPERTY] !== "true" ||
    !file.parents?.includes(evidenceDriveFolderId())
  ) {
    throw new Error("Sesi upload evidence tidak valid atau sudah digunakan.");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_EVIDENCE_BYTES) {
    await rejectUploadedFile(
      drive,
      fileId,
      "Ukuran file evidence tidak valid atau melebihi 100 MB.",
    );
  }
  const metadataError = validateEvidenceFile(
    { name: file.name ?? "", type: file.mimeType ?? "", size },
    kind,
  );
  if (metadataError) await rejectUploadedFile(drive, fileId, metadataError);
  const checksum = file.md5Checksum;
  if (!checksum) {
    return rejectUploadedFile(
      drive,
      fileId,
      "Google Drive tidak mengembalikan checksum file evidence.",
    );
  }

  const token = await accessToken(client);
  const extension = evidenceFileExtension(file.name ?? "");
  if (!(await driveFileMatchesSignature(fileId, extension, size, token))) {
    await rejectUploadedFile(
      drive,
      fileId,
      "Isi file tidak sesuai dengan format evidence.",
    );
  }

  const fingerprint = evidenceFingerprint(key, file.name ?? "", checksum);
  await drive.files.update({
    fileId,
    supportsAllDrives: true,
    requestBody: {
      appProperties: {
        ...properties,
        [UPLOAD_PENDING_PROPERTY]: "false",
        [EVIDENCE_HASH_PROPERTY]: fingerprint,
      },
    },
    fields: "id",
  }, driveTimeout);

  // Independent Drive calls run together. Sharing a file the duplicate check then
  // deletes is harmless, so its failure is reported only when this file is kept.
  const [winner, shareError] = await Promise.all([
    settleDuplicates(drive, fingerprint, fileId),
    shareByLink(drive, fileId),
  ]);
  if (winner && winner.fileId !== fileId) return { ...winner, reused: true };
  if (shareError) {
    console.error(
      `Evidence file ${fileId} tidak bisa dibagikan lewat link. Link di kolom Q hanya bisa dibuka oleh pemilik file.`,
      shareError,
    );
  }
  return {
    fileId,
    webViewLink: viewOnlyLink(
      file.webViewLink ??
        `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
    ),
    reused: false,
  };
}

async function driveFileMatchesSignature(
  fileId: string,
  extension: string,
  size: number,
  token: string,
): Promise<boolean> {
  const readRange = async (start: number, end: number) => {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
    });
    if (!response.ok) throw await driveResponseError(response);
    return new Uint8Array(await response.arrayBuffer());
  };

  const head = await readRange(0, Math.min(size, SAMPLE_BYTES) - 1);
  if (extension !== "docx" || size <= SAMPLE_BYTES) {
    return matchesEvidenceSignature(head, extension);
  }
  const tail = await readRange(Math.max(SAMPLE_BYTES, size - SAMPLE_BYTES), size - 1);
  const combined = new Uint8Array(head.length + tail.length);
  combined.set(head);
  combined.set(tail, head.length);
  return matchesEvidenceSignature(combined, extension);
}

/** Files carrying this fingerprint, oldest first, with ID as a stable tiebreak. */
async function fingerprintMatches(
  drive: drive_v3.Drive,
  fingerprint: string,
): Promise<{ fileId: string; webViewLink: string }[]> {
  const listed = await drive.files.list({
    q: `appProperties has { key='${EVIDENCE_HASH_PROPERTY}' and value='${fingerprint}' } and '${evidenceDriveFolderId()}' in parents and trashed = false`,
    fields: "files(id,webViewLink,createdTime)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  }, driveTimeout);
  return (listed.data.files ?? [])
    .filter((found): found is drive_v3.Schema$File & { id: string } => !!found.id)
    .sort(
      (a, b) =>
        (a.createdTime ?? "").localeCompare(b.createdTime ?? "") ||
        a.id.localeCompare(b.id),
    )
    .map((found) => ({
      fileId: found.id,
      webViewLink: viewOnlyLink(
        found.webViewLink ??
          `https://drive.google.com/file/d/${encodeURIComponent(found.id)}/view`,
      ),
    }));
}

async function settleDuplicates(
  drive: drive_v3.Drive,
  fingerprint: string,
  ownFileId: string,
): Promise<{ fileId: string; webViewLink: string } | null> {
  try {
    const matches = await fingerprintMatches(drive, fingerprint);
    const winner = matches[0];
    if (!winner || winner.fileId === ownFileId) return null;
    await drive.files.delete({ fileId: ownFileId, supportsAllDrives: true }, driveTimeout);
    return winner;
  } catch (error) {
    console.error(
      `Could not settle duplicate evidence uploads for ${ownFileId}; the file was kept.`,
      error,
    );
    return null;
  }
}

async function shareByLink(drive: drive_v3.Drive, fileId: string): Promise<unknown> {
  try {
    await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      requestBody: { role: "reader", type: "anyone" },
    });
    return null;
  } catch (error) {
    return error;
  }
}

async function rejectUploadedFile(
  drive: drive_v3.Drive,
  fileId: string,
  message: string,
): Promise<never> {
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true }, driveTimeout);
  } catch (error) {
    console.error(`Rejected evidence file ${fileId} could not be deleted.`, error);
  }
  throw new Error(message);
}

export async function deleteEvidenceFile(fileId: string): Promise<void> {
  const drive = driveApi({ version: "v3", auth: evidenceAuth() });
  for (let attempt = 0; ; attempt++) {
    try {
      await drive.files.delete({ fileId, supportsAllDrives: true }, driveTimeout);
      return;
    } catch (error) {
      const status = (error as { status?: number; code?: number }).status
        ?? (error as { code?: number }).code;
      if (status === 404) return;
      if (attempt >= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function driveFriendlyError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid_grant/i.test(message)) {
    return new Error(
      "Otorisasi Google Drive sudah tidak berlaku. Admin perlu membuat GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN baru lalu melakukan redeploy.",
    );
  }
  if (/storage quota|storageQuotaExceeded/i.test(message)) {
    return new Error("Kuota penyimpanan akun pemilik folder Google Drive tidak mencukupi.");
  }
  if (/timeout|aborted|ECONNRESET/i.test(message)) {
    return new Error("Google Drive tidak merespons sampai batas waktu. Silakan coba lagi.");
  }
  return error instanceof Error ? error : new Error(message);
}

async function driveResponseError(response: Response): Promise<Error> {
  const body = await response.text();
  return driveFriendlyError(
    new Error(`Google Drive menolak upload (${response.status}): ${body.slice(0, 500)}`),
  );
}
