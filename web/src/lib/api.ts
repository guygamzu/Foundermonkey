const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface OtherField {
  id: string;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: string | null;
  signerName: string | null;
}

export interface SigningSession {
  document: {
    id: string;
    fileName: string;
    pageCount: number;
    documentUrl: string | null;
    signingMode?: 'shared' | 'individual';
  };
  signer: {
    id: string;
    name: string | null;
    email: string | null;
  };
  otherFields?: OtherField[];
  fields: Array<{
    id: string;
    type: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    required: boolean;
    value: string | null;
    completed: boolean;
  }>;
}

export interface DocumentSigner {
  name: string | null;
  email: string | null;
  status: 'pending' | 'notified' | 'viewed' | 'signed' | 'declined';
  signedAt: string | null;
}

export interface DocumentStatus {
  id: string;
  fileName: string;
  status: 'sent' | 'partially_signed' | 'completed' | 'declined' | 'expired' | 'pending_confirmation';
  createdAt: string;
  completedAt: string | null;
  signers: DocumentSigner[];
}

export interface QAResponse {
  answer: string;
  citations: Array<{ section: string; text: string }>;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function getSigningSession(token: string): Promise<SigningSession> {
  return apiFetch(`/api/signing/session/${token}`);
}

export function getDocumentProxyUrl(token: string): string {
  return `${API_URL}/api/signing/session/${token}/document`;
}

export function getPreviewDocumentProxyUrl(documentId: string): string {
  return `${API_URL}/api/documents/preview/${documentId}/document`;
}

export async function submitFieldValue(token: string, fieldId: string, value: string): Promise<void> {
  await apiFetch(`/api/signing/session/${token}/fields/${fieldId}`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

export interface PlacedField {
  id: string;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: string | null;
  completed: boolean;
}

export async function createField(
  token: string,
  field: { type: string; page: number; x: number; y: number; width?: number; height?: number; value?: string },
): Promise<PlacedField> {
  const res = await apiFetch<{ field: PlacedField }>(`/api/signing/session/${token}/fields`, {
    method: 'POST',
    body: JSON.stringify(field),
  });
  return res.field;
}

export async function completeSigning(token: string): Promise<{ allCompleted: boolean }> {
  return apiFetch(`/api/signing/session/${token}/complete`, {
    method: 'POST',
    body: JSON.stringify({ consent: true }),
  });
}

export async function declineSigning(token: string, reason?: string): Promise<void> {
  await apiFetch(`/api/signing/session/${token}/decline`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function getDocumentStatus(documentId: string): Promise<DocumentStatus> {
  return apiFetch(`/api/documents/status/${documentId}`);
}

export async function askDocumentQuestion(
  token: string,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<QAResponse> {
  return apiFetch(`/api/signing/session/${token}/qa`, {
    method: 'POST',
    body: JSON.stringify({ question, history }),
  });
}

export async function askPreviewQuestion(
  documentId: string,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<QAResponse> {
  return apiFetch(`/api/documents/preview/${documentId}/qa`, {
    method: 'POST',
    body: JSON.stringify({ question, history }),
  });
}

// Setup page types and functions

export interface SetupSigner {
  id: string;
  name: string | null;
  email: string | null;
  signingOrder: number;
}

export interface SetupField {
  id: string;
  signerId: string;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  isTemplate?: boolean;
}

export interface SetupDocument {
  id: string;
  fileName: string;
  pageCount: number;
  isSequential: boolean;
  signingMode: 'shared' | 'individual';
  creditsRequired: number;
  status?: string;
  warning?: { alreadySent: boolean; signerCount: number; signedCount: number };
  signers: SetupSigner[];
  fields: SetupField[];
}

export async function getSetupDocument(id: string): Promise<SetupDocument> {
  return apiFetch(`/api/setup/${id}`);
}

export function getSetupDocumentProxyUrl(id: string): string {
  return `${API_URL}/api/setup/${id}/document`;
}

export async function createSetupField(
  id: string,
  field: { signerId: string; type: string; page: number; x: number; y: number; width?: number; height?: number },
): Promise<SetupField> {
  return apiFetch(`/api/setup/${id}/fields`, {
    method: 'POST',
    body: JSON.stringify(field),
  });
}

export async function deleteSetupField(id: string, fieldId: string): Promise<void> {
  await apiFetch(`/api/setup/${id}/fields/${fieldId}`, { method: 'DELETE' });
}

export async function updateSetupFieldPosition(
  id: string, fieldId: string, x: number, y: number,
): Promise<{ id: string; x: number; y: number }> {
  return apiFetch(`/api/setup/${id}/fields/${fieldId}`, {
    method: 'PATCH',
    body: JSON.stringify({ x, y }),
  });
}

export async function addSetupSigner(
  id: string, data: { name?: string; email: string },
): Promise<SetupSigner> {
  return apiFetch(`/api/setup/${id}/signers`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeSetupSigner(id: string, signerId: string): Promise<void> {
  await apiFetch(`/api/setup/${id}/signers/${signerId}`, { method: 'DELETE' });
}

export async function updateSetupSigningMode(
  id: string, signingMode: 'shared' | 'individual',
): Promise<void> {
  await apiFetch(`/api/setup/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ signingMode }),
  });
}

export async function sendForSigning(id: string): Promise<{ success: boolean; statusUrl: string }> {
  return apiFetch(`/api/setup/${id}/send`, { method: 'POST' });
}

export async function finishSetup(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/setup/${id}/done`, { method: 'POST' });
}

export async function voidAndReconfigure(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/setup/${id}/void-and-reconfigure`, { method: 'POST' });
}
