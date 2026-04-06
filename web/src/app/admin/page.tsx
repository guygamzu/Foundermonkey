'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface DashboardData {
  users: { total: number; today: number; thisWeek: number; thisMonth: number };
  documents: { total: number; today: number; thisWeek: number; byStatus: Record<string, number> };
  signers: { total: number; signedToday: number; byStatus: Record<string, number> };
  credits: { totalRemaining: number; totalPurchased: number; purchaseCount: number };
  recent: {
    users: Array<{ id: string; email: string; name: string | null; credits: number; is_provisional: boolean; created_at: string }>;
    documents: Array<{ id: string; file_name: string; status: string; created_at: string; completed_at: string | null; sender_email: string }>;
    signings: Array<{ id: string; email: string; name: string | null; status: string; signed_at: string; file_name: string }>;
  };
  dailyActivity: Array<{ date: string; new_users: number; new_docs: number; signings: number; credits_purchased: number }>;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    completed: { bg: '#dcfce7', text: '#166534' },
    signed: { bg: '#dcfce7', text: '#166534' },
    sent: { bg: '#dbeafe', text: '#1e40af' },
    pending: { bg: '#fef9c3', text: '#854d0e' },
    notified: { bg: '#e0e7ff', text: '#3730a3' },
    viewed: { bg: '#fce7f3', text: '#9d174d' },
    declined: { bg: '#fee2e2', text: '#991b1b' },
    expired: { bg: '#f3f4f6', text: '#6b7280' },
    draft: { bg: '#f3f4f6', text: '#6b7280' },
    insufficient_credits: { bg: '#fef3c7', text: '#92400e' },
    partially_signed: { bg: '#e0f2fe', text: '#0369a1' },
  };
  const c = colors[status] || { bg: '#f3f4f6', text: '#374151' };
  return (
    <span style={{ padding: '2px 8px', borderRadius: 4, background: c.bg, color: c.text, fontSize: 12, fontWeight: 500 }}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function MiniChart({ data, dataKey, color }: { data: Array<Record<string, any>>; dataKey: string; color: string }) {
  if (!data.length) return null;
  const values = data.map(d => Number(d[dataKey]) || 0);
  const max = Math.max(...values, 1);
  const barWidth = 100 / data.length;

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', height: 40, gap: 2, width: '100%' }}>
      {values.map((v, i) => (
        <div
          key={i}
          title={`${data[i].date}: ${v}`}
          style={{
            flex: 1,
            height: `${Math.max((v / max) * 100, 2)}%`,
            background: color,
            borderRadius: '2px 2px 0 0',
            minWidth: 4,
            opacity: i === values.length - 1 ? 1 : 0.6,
          }}
        />
      ))}
    </div>
  );
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const secret = searchParams.get('secret') || '';
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [alertSending, setAlertSending] = useState(false);
  const [alertSent, setAlertSent] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/admin/dashboard?secret=${encodeURIComponent(secret)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [secret]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const sendAlert = async () => {
    setAlertSending(true);
    try {
      await fetch(`${API_URL}/api/admin/send-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      });
      setAlertSent(true);
      setTimeout(() => setAlertSent(false), 3000);
    } catch { /* ignore */ }
    setAlertSending(false);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ color: '#dc2626' }}>Access Denied</h2>
        <p style={{ color: '#6b7280' }}>{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const statCards = [
    { label: 'Total Users', value: data.users.total, sub: `+${data.users.today} today`, color: '#2563eb', bg: '#eff6ff', chartKey: 'new_users' },
    { label: 'Total Documents', value: data.documents.total, sub: `+${data.documents.today} today`, color: '#16a34a', bg: '#f0fdf4', chartKey: 'new_docs' },
    { label: 'Total Signers', value: data.signers.total, sub: `${data.signers.signedToday} signed today`, color: '#ca8a04', bg: '#fefce8', chartKey: 'signings' },
    { label: 'Credits in System', value: data.credits.totalRemaining, sub: `${data.credits.totalPurchased} purchased (${data.credits.purchaseCount} txns)`, color: '#7c3aed', bg: '#faf5ff', chartKey: 'credits_purchased' },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111827' }}>Lapen Dashboard</h1>
          <p style={{ color: '#6b7280', fontSize: 14 }}>Real-time service activity (auto-refreshes every 30s)</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={fetchData}
            style={{ padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', cursor: 'pointer', fontSize: 13 }}
          >
            Refresh
          </button>
          <button
            onClick={sendAlert}
            disabled={alertSending}
            style={{
              padding: '8px 16px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: alertSent ? '#16a34a' : '#2563eb', color: 'white', opacity: alertSending ? 0.6 : 1,
            }}
          >
            {alertSent ? 'Sent!' : alertSending ? 'Sending...' : 'Email Report'}
          </button>
        </div>
      </div>

      {/* Stat Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 }}>
        {statCards.map((card) => (
          <div key={card.label} style={{ background: card.bg, padding: 20, borderRadius: 12, border: `1px solid ${card.color}20` }}>
            <div style={{ fontSize: 32, fontWeight: 700, color: card.color }}>{card.value.toLocaleString()}</div>
            <div style={{ fontSize: 14, color: '#374151', fontWeight: 500, marginBottom: 2 }}>{card.label}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{card.sub}</div>
            <MiniChart data={data.dailyActivity} dataKey={card.chartKey} color={card.color} />
          </div>
        ))}
      </div>

      {/* Period Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#374151' }}>{data.users.thisWeek}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>Users this week</div>
        </div>
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#374151' }}>{data.users.thisMonth}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>Users this month</div>
        </div>
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#374151' }}>{data.documents.thisWeek}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>Docs this week</div>
        </div>
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#374151' }}>
            {data.documents.byStatus.completed || 0}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>Total completed</div>
        </div>
      </div>

      {/* Document Status Breakdown */}
      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Documents by Status</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {Object.entries(data.documents.byStatus)
            .sort(([, a], [, b]) => b - a)
            .map(([status, count]) => (
              <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <StatusBadge status={status} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>{count}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Signer Status Breakdown */}
      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Signers by Status</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {Object.entries(data.signers.byStatus)
            .sort(([, a], [, b]) => b - a)
            .map(([status, count]) => (
              <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <StatusBadge status={status} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>{count}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Recent Tables */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 24 }}>
        {/* Recent Users */}
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, overflow: 'auto' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Recent Users</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Email</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Name</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500, color: '#6b7280' }}>Credits</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Joined</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.users.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px' }}>{u.email}</td>
                  <td style={{ padding: '8px 12px', color: u.name ? '#374151' : '#9ca3af' }}>{u.name || '-'}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: u.credits < 5 ? '#dc2626' : '#374151' }}>{u.credits}</td>
                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Recent Documents */}
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, overflow: 'auto' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Recent Documents</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Sender</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Document</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Status</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.documents.map((d) => (
                <tr key={d.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px' }}>{d.sender_email}</td>
                  <td style={{ padding: '8px 12px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.file_name}</td>
                  <td style={{ padding: '8px 12px' }}><StatusBadge status={d.status} /></td>
                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{new Date(d.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Recent Signings */}
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, overflow: 'auto' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Recent Signings</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Signer</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Document</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Signed At</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.signings.map((s) => (
                <tr key={s.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px' }}>{s.email || s.name || '-'}</td>
                  <td style={{ padding: '8px 12px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.file_name}</td>
                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{s.signed_at ? new Date(s.signed_at).toLocaleString() : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Daily Activity Table */}
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, overflow: 'auto' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Daily Activity (Last 14 Days)</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#6b7280' }}>Date</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500, color: '#6b7280' }}>New Users</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500, color: '#6b7280' }}>New Docs</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500, color: '#6b7280' }}>Signings</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500, color: '#6b7280' }}>Credits Purchased</th>
              </tr>
            </thead>
            <tbody>
              {[...data.dailyActivity].reverse().map((d) => (
                <tr key={d.date} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px' }}>{new Date(d.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: d.new_users > 0 ? 600 : 400, color: d.new_users > 0 ? '#2563eb' : '#9ca3af' }}>{d.new_users}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: d.new_docs > 0 ? 600 : 400, color: d.new_docs > 0 ? '#16a34a' : '#9ca3af' }}>{d.new_docs}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: d.signings > 0 ? 600 : 400, color: d.signings > 0 ? '#ca8a04' : '#9ca3af' }}>{d.signings}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: d.credits_purchased > 0 ? 600 : 400, color: d.credits_purchased > 0 ? '#7c3aed' : '#9ca3af' }}>{d.credits_purchased}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ textAlign: 'center', padding: '24px 0', color: '#9ca3af', fontSize: 12 }}>
        Lapen Admin Dashboard &bull; Auto-refreshes every 30 seconds
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}><div className="spinner" /></div>}>
      <DashboardContent />
    </Suspense>
  );
}
