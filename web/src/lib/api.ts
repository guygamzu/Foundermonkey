const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface SigningSession {
  document: {
    id: string;
    fileName: string;
    pageCount: number;
    documentUrl: string | null;
  };
  signer: {
    id: string;
    name: string | null;
    email: string | null;
  };
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
