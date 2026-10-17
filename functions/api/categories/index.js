// functions/api/categories/index.js
import { errorResponse, jsonResponse } from '../../_middleware';

let columnsChecked = false;

export async function onRequestGet(context) {
  const { request, env } = context;

  // 分类列表是公开数据（首页直接渲染分类树），前台"添加新书签"弹窗需要无登录加载分类，
  // 因此 GET 列表接口不做 admin 鉴权。增删改（create.js / [id].js）仍保持 admin 鉴权。
  
  if (!columnsChecked) {
      try {
          await env.NAV_DB.prepare("SELECT parent_id FROM category LIMIT 1").first();
          columnsChecked = true;
      } catch (e) {
          try {
              await env.NAV_DB.prepare("ALTER TABLE category ADD COLUMN parent_id INTEGER DEFAULT 0").run();
              columnsChecked = true;
          } catch (e2) {
              console.error("Failed to add parent_id", e2);
          }
      }
  }

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);
  const offset = (page - 1) * pageSize;

  try {
    const { results } = await env.NAV_DB.prepare(`
        SELECT c.id, c.catelog, c.sort_order, c.parent_id, COUNT(s.id) AS site_count
        FROM category c
        LEFT JOIN sites s ON c.id = s.catelog_id
        GROUP BY c.id, c.catelog, c.sort_order, c.parent_id
        ORDER BY c.sort_order ASC, c.create_time DESC
        LIMIT ? OFFSET ?
      `).bind(pageSize, offset).all();
    const countResult = await env.NAV_DB.prepare(`
      SELECT COUNT(*) as total FROM category
    `).first();

    const total = countResult ? countResult.total : 0;

    return jsonResponse({
      code: 200,
      data: results,
      total,
      page,
      pageSize
    });
  } catch (e) {
    return errorResponse(`Failed to fetch categories: ${e.message}`, 500);
  }
}
