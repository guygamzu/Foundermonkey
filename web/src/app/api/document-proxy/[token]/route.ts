import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  try {
    const upstream = await fetch(
      `${API_URL}/api/signing/session/${token}/document`,
      { signal: AbortSignal.timeout(30_000) },
    );

    if (!upstream.ok) {
      return NextResponse.json(
        { error: 'Document not available' },
        { status: upstream.status },
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/pdf');
    if (upstream.headers.get('Content-Length')) {
      headers.set('Content-Length', upstream.headers.get('Content-Length')!);
    }
    headers.set('Cache-Control', 'private, max-age=300');

    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (err) {
    console.error('[document-proxy]', err);
    return NextResponse.json({ error: 'Failed to fetch document' }, { status: 502 });
  }
}
