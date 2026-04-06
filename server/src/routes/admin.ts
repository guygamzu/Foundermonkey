import { Router, Request, Response } from 'express';
import { getDatabase } from '../config/database.js';
import { EmailService } from '../services/EmailService.js';
import { logger } from '../config/logger.js';

const ADMIN_EMAIL = 'guy.gamzu@gmail.com';

function requireAdminSecret(req: Request, res: Response): boolean {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'Admin secret not configured' });
    return false;
  }
  if (secret !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function createAdminRouter(): Router {
  const router = Router();
  const db = getDatabase();

  // Dashboard overview metrics
  router.get('/dashboard', async (req: Request, res: Response) => {
    if (!requireAdminSecret(req, res)) return;

    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - 7);
      const monthStart = new Date(todayStart);
      monthStart.setDate(monthStart.getDate() - 30);

      // Run all queries in parallel
      const [
        totalUsers,
        usersToday,
        usersThisWeek,
        usersThisMonth,
        totalDocs,
        docsToday,
        docsThisWeek,
        docsByStatus,
        totalSigners,
        signersByStatus,
        signersToday,
        creditStats,
        creditPurchases,
        recentUsers,
        recentDocs,
        recentSignings,
        dailyActivity,
      ] = await Promise.all([
        // Users
        db('users').count('id as count').first(),
        db('users').where('created_at', '>=', todayStart).count('id as count').first(),
        db('users').where('created_at', '>=', weekStart).count('id as count').first(),
        db('users').where('created_at', '>=', monthStart).count('id as count').first(),

        // Documents
        db('document_requests').count('id as count').first(),
        db('document_requests').where('created_at', '>=', todayStart).count('id as count').first(),
        db('document_requests').where('created_at', '>=', weekStart).count('id as count').first(),
        db('document_requests').select('status').count('id as count').groupBy('status'),

        // Signers
        db('signers').count('id as count').first(),
        db('signers').select('status').count('id as count').groupBy('status'),
        db('signers').where('signed_at', '>=', todayStart).count('id as count').first(),

        // Credits
        db('users').sum('credits as total_remaining').first(),
        db('credit_transactions')
          .where('amount', '>', 0)
          .select(
            db.raw('count(*) as purchase_count'),
            db.raw('sum(amount) as total_purchased'),
          )
          .first(),

        // Recent users (last 10)
        db('users')
          .select('id', 'email', 'name', 'credits', 'is_provisional', 'created_at')
          .orderBy('created_at', 'desc')
          .limit(10),

        // Recent documents (last 10)
        db('document_requests')
          .select('document_requests.id', 'document_requests.file_name', 'document_requests.status', 'document_requests.created_at', 'document_requests.completed_at', 'users.email as sender_email')
          .leftJoin('users', 'document_requests.sender_id', 'users.id')
          .orderBy('document_requests.created_at', 'desc')
          .limit(10),

        // Recent signings (last 10)
        db('signers')
          .select('signers.id', 'signers.email', 'signers.name', 'signers.status', 'signers.signed_at', 'document_requests.file_name')
          .leftJoin('document_requests', 'signers.document_request_id', 'document_requests.id')
          .whereNotNull('signers.signed_at')
          .orderBy('signers.signed_at', 'desc')
          .limit(10),

        // Daily activity (last 14 days)
        db.raw(`
          SELECT
            d::date as date,
            (SELECT count(*) FROM users WHERE created_at::date = d::date) as new_users,
            (SELECT count(*) FROM document_requests WHERE created_at::date = d::date) as new_docs,
            (SELECT count(*) FROM signers WHERE signed_at::date = d::date) as signings,
            (SELECT coalesce(sum(amount), 0) FROM credit_transactions WHERE amount > 0 AND created_at::date = d::date) as credits_purchased
          FROM generate_series(
            (now() - interval '13 days')::date,
            now()::date,
            '1 day'::interval
          ) d
          ORDER BY d ASC
        `),
      ]);

      res.json({
        users: {
          total: Number(totalUsers?.count || 0),
          today: Number(usersToday?.count || 0),
          thisWeek: Number(usersThisWeek?.count || 0),
          thisMonth: Number(usersThisMonth?.count || 0),
        },
        documents: {
          total: Number(totalDocs?.count || 0),
          today: Number(docsToday?.count || 0),
          thisWeek: Number(docsThisWeek?.count || 0),
          byStatus: Object.fromEntries(docsByStatus.map((r: any) => [r.status, Number(r.count)])),
        },
        signers: {
          total: Number(totalSigners?.count || 0),
          signedToday: Number(signersToday?.count || 0),
          byStatus: Object.fromEntries(signersByStatus.map((r: any) => [r.status, Number(r.count)])),
        },
        credits: {
          totalRemaining: Number(creditStats?.total_remaining || 0),
          totalPurchased: Number(creditPurchases?.total_purchased || 0),
          purchaseCount: Number(creditPurchases?.purchase_count || 0),
        },
        recent: {
          users: recentUsers,
          documents: recentDocs,
          signings: recentSignings,
        },
        dailyActivity: dailyActivity.rows,
      });
    } catch (err) {
      logger.error({ err }, 'Admin dashboard error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Send alert email with current stats
  router.post('/send-alert', async (req: Request, res: Response) => {
    if (!requireAdminSecret(req, res)) return;

    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const [
        totalUsers,
        usersToday,
        totalDocs,
        docsToday,
        signersToday,
        creditStats,
        recentActivity,
      ] = await Promise.all([
        db('users').count('id as count').first(),
        db('users').where('created_at', '>=', todayStart).count('id as count').first(),
        db('document_requests').count('id as count').first(),
        db('document_requests').where('created_at', '>=', todayStart).count('id as count').first(),
        db('signers').where('signed_at', '>=', todayStart).count('id as count').first(),
        db('users').sum('credits as total_remaining').first(),
        db('document_requests')
          .select('document_requests.file_name', 'document_requests.status', 'document_requests.created_at', 'users.email as sender_email')
          .leftJoin('users', 'document_requests.sender_id', 'users.id')
          .where('document_requests.created_at', '>=', todayStart)
          .orderBy('document_requests.created_at', 'desc')
          .limit(20),
      ]);

      const emailService = new EmailService();

      const activityRows = recentActivity.map((a: any) =>
        `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${a.sender_email}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${a.file_name}</td><td style="padding:4px 8px;border-bottom:1px solid #eee"><span style="padding:2px 8px;border-radius:4px;background:${a.status === 'completed' ? '#dcfce7' : a.status === 'sent' ? '#dbeafe' : '#fef9c3'};font-size:12px">${a.status}</span></td><td style="padding:4px 8px;border-bottom:1px solid #eee">${new Date(a.created_at).toLocaleTimeString()}</td></tr>`
      ).join('');

      const html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#2563eb;margin-bottom:20px">Lapen Daily Activity Report</h2>
          <p style="color:#6b7280;margin-bottom:20px">${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
            <div style="background:#eff6ff;padding:16px;border-radius:8px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#2563eb">${Number(totalUsers?.count || 0)}</div>
              <div style="font-size:13px;color:#6b7280">Total Users</div>
              <div style="font-size:12px;color:#16a34a;margin-top:4px">+${Number(usersToday?.count || 0)} today</div>
            </div>
            <div style="background:#f0fdf4;padding:16px;border-radius:8px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#16a34a">${Number(totalDocs?.count || 0)}</div>
              <div style="font-size:13px;color:#6b7280">Total Documents</div>
              <div style="font-size:12px;color:#16a34a;margin-top:4px">+${Number(docsToday?.count || 0)} today</div>
            </div>
            <div style="background:#fefce8;padding:16px;border-radius:8px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#ca8a04">${Number(signersToday?.count || 0)}</div>
              <div style="font-size:13px;color:#6b7280">Signings Today</div>
            </div>
            <div style="background:#faf5ff;padding:16px;border-radius:8px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#7c3aed">${Number(creditStats?.total_remaining || 0)}</div>
              <div style="font-size:13px;color:#6b7280">Credits in System</div>
            </div>
          </div>

          ${recentActivity.length > 0 ? `
          <h3 style="font-size:14px;color:#374151;margin-bottom:8px">Today's Activity</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
            <thead><tr style="background:#f9fafb">
              <th style="padding:6px 8px;text-align:left">Sender</th>
              <th style="padding:6px 8px;text-align:left">Document</th>
              <th style="padding:6px 8px;text-align:left">Status</th>
              <th style="padding:6px 8px;text-align:left">Time</th>
            </tr></thead>
            <tbody>${activityRows}</tbody>
          </table>` : '<p style="color:#9ca3af;font-size:13px">No activity today yet.</p>'}

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0"/>
          <p style="font-size:12px;color:#9ca3af;text-align:center">
            Lapen Admin Alert &bull; <a href="${process.env.APP_URL}/admin?secret=${process.env.ADMIN_SECRET}" style="color:#2563eb">Open Dashboard</a>
          </p>
        </div>
      `;

      await emailService.sendEmail({
        to: ADMIN_EMAIL,
        subject: `Lapen Report: ${Number(usersToday?.count || 0)} new users, ${Number(docsToday?.count || 0)} docs today`,
        text: `Lapen Daily Report\nUsers: ${totalUsers?.count} (${usersToday?.count} today)\nDocuments: ${totalDocs?.count} (${docsToday?.count} today)\nSignings today: ${signersToday?.count}\nCredits in system: ${creditStats?.total_remaining}`,
        html,
      });

      res.json({ success: true, sentTo: ADMIN_EMAIL });
    } catch (err) {
      logger.error({ err }, 'Admin alert email error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Real-time event alerts (called internally when key events happen)
  router.post('/notify-event', async (req: Request, res: Response) => {
    if (!requireAdminSecret(req, res)) return;

    try {
      const { event, data } = req.body;
      const emailService = new EmailService();

      let subject = '';
      let html = '';

      switch (event) {
        case 'new_user':
          subject = `New Lapen user: ${data.email}`;
          html = `<p><strong>${data.email}</strong> just signed up for Lapen.</p>`;
          break;
        case 'document_completed':
          subject = `Document completed: ${data.fileName}`;
          html = `<p><strong>${data.fileName}</strong> was fully signed. Sender: ${data.senderEmail}</p>`;
          break;
        case 'credit_purchase':
          subject = `Credit purchase: ${data.credits} credits by ${data.email}`;
          html = `<p><strong>${data.email}</strong> purchased <strong>${data.credits} credits</strong>.</p>`;
          break;
        default:
          subject = `Lapen event: ${event}`;
          html = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
      }

      await emailService.sendEmail({
        to: ADMIN_EMAIL,
        subject,
        text: subject,
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px">${html}<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/><p style="font-size:12px;color:#9ca3af"><a href="${process.env.APP_URL}/admin?secret=${process.env.ADMIN_SECRET}" style="color:#2563eb">Open Dashboard</a></p></div>`,
      });

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Admin event notification error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Helper for internal use — fire-and-forget admin notification
export async function notifyAdmin(event: string, data: Record<string, unknown>): Promise<void> {
  try {
    const emailService = new EmailService();
    const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
    const adminSecret = process.env.ADMIN_SECRET;

    let subject = '';
    let html = '';

    switch (event) {
      case 'new_user':
        subject = `New Lapen user: ${data.email}`;
        html = `<p><strong>${data.email}</strong> just signed up for Lapen.</p>`;
        break;
      case 'document_completed':
        subject = `Document completed: ${data.fileName}`;
        html = `<p><strong>${data.fileName}</strong> was fully signed. Sender: ${data.senderEmail}</p>`;
        break;
      case 'credit_purchase':
        subject = `Credit purchase: ${data.credits} credits by ${data.email}`;
        html = `<p><strong>${data.email}</strong> purchased <strong>${data.credits} credits</strong>.</p>`;
        break;
      default:
        subject = `Lapen event: ${event}`;
        html = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
    }

    await emailService.sendEmail({
      to: ADMIN_EMAIL,
      subject,
      text: subject,
      html: `<div style="font-family:system-ui,sans-serif;max-width:500px">${html}<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/><p style="font-size:12px;color:#9ca3af"><a href="${appUrl}/admin?secret=${adminSecret}" style="color:#2563eb">Open Dashboard</a></p></div>`,
    });
  } catch (err) {
    logger.warn({ err, event }, 'Failed to send admin notification (non-fatal)');
  }
}
