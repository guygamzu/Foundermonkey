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

    const buffer = await upstream.arrayBuffer();

    return new NextResponse(Buffer.from(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': buffer.byteLength.toString(),
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    console.error('[document-proxy]', err);
    return NextResponse.json({ error: 'Failed to fetch document' }, { status: 502 });
  }
}
