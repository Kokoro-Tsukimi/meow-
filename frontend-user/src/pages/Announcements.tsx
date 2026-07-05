import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../api/client';
import MarkdownContent from '../components/MarkdownContent';

// ====================================================
// G-4 公告历史页(/announcements)
// 入口在喵屋大厅公告卡右上角「查看全部 →」, 不占侧栏位
// 分页由后端 /announcements/history 提供(parsePagination, 10 条/页)
// ====================================================

interface Announcement {
  id: number;
  title: string;
  content: string;
  created_at: string;
}

const PAGE_SIZE = 10;

export default function Announcements() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    fetchPage(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const fetchPage = async (p: number) => {
    setLoading(true);
    try {
      console.info(`[USER-PORTAL][Announcements][Fetch] page ${p}`);
      const res = await apiClient.get('/api/v1/user/announcements/history', {
        params: { page: p, limit: PAGE_SIZE },
      });
      setItems(res.data.items || []);
      setTotal(res.data.total || 0);
    } catch (error) {
      console.error('[USER-PORTAL][Announcements][Fetch] Error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen font-harmony">
      <main className="max-w-4xl mx-auto p-8 space-y-6">
        {/* 页头:标题 + 回大厅 */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h1 className="text-2xl meow-h">📢 公告历史</h1>
          <Link to="/dashboard" className="text-sm meow-text-sub underline">
            ← 回喵屋大厅
          </Link>
        </div>

        {loading ? (
          <div className="meow-card p-10 text-center meow-text-sub">
            <div className="text-4xl mb-3 animate-float">📜</div>
            <p>翻找公告存档中喵...</p>
          </div>
        ) : items.length === 0 ? (
          <div className="meow-card p-10 text-center meow-text-sub">
            <div className="text-4xl mb-3 animate-float">🍃</div>
            <p>还没有任何公告喵~</p>
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((a) => (
              <div key={a.id} className="meow-card p-6">
                <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
                  <h2 className="font-bold text-lg meow-text">{a.title}</h2>
                  <span className="text-xs meow-text-sub">
                    {new Date(a.created_at).toLocaleString('zh-CN')}
                  </span>
                </div>
                <MarkdownContent content={a.content} />
              </div>
            ))}
          </div>
        )}

        {/* 分页条(总数不超过一页时隐藏) */}
        {!loading && total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-4 pt-2 flex-wrap">
            <button
              className="meow-page-btn"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← 上一页
            </button>
            <span className="text-sm meow-text-sub">
              第 {page} / {totalPages} 页 · 共 {total} 条
            </span>
            <button
              className="meow-page-btn"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页 →
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
