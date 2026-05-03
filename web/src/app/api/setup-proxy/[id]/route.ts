import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const res = await fetch(`${API_URL}/api/setup/${id}/document`);
    if (!res.ok) {
      return NextResponse.json(
        { error: 'Document not available' },
        { status: res.status },
      );
    }

    const buffer = await res.arrayBuffer();
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch document' },
      { status: 502 },
    );
  }
}
