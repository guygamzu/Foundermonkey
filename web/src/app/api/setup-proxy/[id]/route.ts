import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const download = request.nextUrl.searchParams.get('download');

  try {
    const upstreamUrl = download
      ? `${API_URL}/api/setup/${id}/document?download=true`
      : `${API_URL}/api/setup/${id}/document`;

    const upstream = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: 'Document not available' },
        { status: upstream.status },
      );
    }

    const buffer = await upstream.arrayBuffer();
    const headers: Record<string, string> = {
      'Content-Type': 'application/pdf',
      'Content-Length': buffer.byteLength.toString(),
      'Cache-Control': 'private, max-age=300',
    };
    const disposition = upstream.headers.get('Content-Disposition');
    if (disposition) headers['Content-Disposition'] = disposition;

    return new NextResponse(Buffer.from(buffer), { status: 200, headers });
  } catch (err) {
    console.error('[setup-proxy]', err);
    return NextResponse.json({ error: 'Failed to fetch document' }, { status: 502 });
  }
}
