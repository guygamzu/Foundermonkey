import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const download = request.nextUrl.searchParams.get('download');

  try {
    const url = download
      ? `${API_URL}/api/setup/${id}/document?download=true`
      : `${API_URL}/api/setup/${id}/document`;

    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
    });

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
    if (upstream.headers.get('Content-Disposition')) {
      headers.set('Content-Disposition', upstream.headers.get('Content-Disposition')!);
    }
    headers.set('Cache-Control', 'private, max-age=300');

    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (err) {
    console.error('[setup-proxy]', err);
    return NextResponse.json({ error: 'Failed to fetch document' }, { status: 502 });
  }
}
