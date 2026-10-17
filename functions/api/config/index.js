// functions/api/config/index.js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder } from '../../_middleware';

let indexesChecked = false;

export async function onRequestGet(context) {
  const { request, env } = context;
  
  // 自动确保索引存在（每个 Worker 实例只执行一次）
  if (!indexesChecked) {
    try {
      await env.NAV_DB.batch([
        env.NAV_DB.prepare("CREATE INDEX IF NOT EXISTS idx_sites_catelog_id ON sites(catelog_id)"),
        env.NAV_DB.prepare("CREATE INDEX IF NOT EXISTS idx_sites_sort_order ON sites(sort_order)")
      ]);
      
      // 检查并添加 is_private 字段
      try {
          await env.NAV_DB.prepare("SELECT is_private FROM sites LIMIT 1").first();
      } catch (e) {
          await env.NAV_DB.prepare("ALTER TABLE sites ADD COLUMN is_private INTEGER DEFAULT 0").run();
      }

      indexesChecked = true;
    } catch (e) {
      console.error('Failed to ensure indexes or columns:', e);
      // 继续执行，不要因为索引创建失败而阻塞主逻辑
    }
  }

  const url = new URL(request.url);
  
  const catalog = url.searchParams.get('catalog');
  const catalogId = url.searchParams.get('catalogId');
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);
  const keyword = url.searchParams.get('keyword');
  const offset = (page - 1) * pageSize;

  const isAuthenticated = await isAdminAuthenticated(request, env);
  const includePrivate = isAuthenticated ? 1 : 0;

  try {
    // 基础查询：关联 sites 和 category
    // 注意：始终筛选 (is_private = 0 OR includePrivate = 1)
    let queryBase = `FROM sites s INNER JOIN category c ON s.catelog_id = c.id WHERE (s.is_private = 0 OR ? = 1)`;
    let queryBindParams = [includePrivate];

    if (catalogId) {
      queryBase += ` AND s.catelog_id = ?`;
      queryBindParams.push(catalogId);
    } else if (catalog) {
      queryBase += ` AND c.catelog = ?`;
      queryBindParams.push(catalog);
    }

    if (keyword) {
      queryBase += ` AND (s.name LIKE ? OR s.url LIKE ? OR c.catelog LIKE ?)`;
      queryBindParams.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const query = `SELECT s.*, c.catelog ${queryBase} ORDER BY s.sort_order ASC, s.create_time DESC LIMIT ? OFFSET ?`;
    const countQuery = `SELECT COUNT(*) as total ${queryBase}`;
    
    // 添加分页参数
    const fullBindParams = [...queryBindParams, pageSize, offset];

    const { results } = await env.NAV_DB.prepare(query).bind(...fullBindParams).all();
    
    // 优化：如果 pageSize 很大（通常是“获取全部”场景），则跳过 COUNT 查询
    let total = 0;
    if (pageSize >= 1000) {
        total = results.length + offset; 
    } else {
        const countResult = await env.NAV_DB.prepare(countQuery).bind(...queryBindParams).first();
        total = countResult ? countResult.total : 0;
    }

    return jsonResponse({
      code: 200,
      data: results,
      total,
      page,
      pageSize
    });
  } catch (e) {
    return errorResponse(`Failed to fetch config data: ${e.message}`, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const config = await request.json();
    const { name, url, logo, desc, catelogId, sort_order, is_private } = config;
    const iconAPI=env.ICON_API ||'https://icons.duckduckgo.com/ip3/';
    
    const sanitizedName = (name || '').trim();
    const sanitizedUrl = (url || '').trim();
    let sanitizedLogo = (logo || '').trim() || null;
    const sanitizedDesc = (desc || '').trim() || null;
    const sortOrderValue = normalizeSortOrder(sort_order);
    const isPrivateValue = is_private ? 1 : 0;

    if (!sanitizedName || !sanitizedUrl || !catelogId) {
      return errorResponse('Name, URL and Catelog are required', 400);
    }
    if(!logo && url){
      if(url.startsWith('https://') || url.startsWith('http://')){
        const domain = url.replace(/^https?:\/\//, '').split('/')[0];
        sanitizedLogo = iconAPI+domain;
        if(!env.ICON_API){
          sanitizedLogo+=''?larger=true'sz=128'
      }
    }
      
    }
    // Find the category ID from the category name
    const categoryResult = await env.NAV_DB.prepare('SELECT catelog FROM category WHERE id = ?').bind(catelogId).first();

    if (!categoryResult) {
      return errorResponse(`Category not found.`, 400);
    }
    const insert = await env.NAV_DB.prepare(`
      INSERT INTO sites (name, url, logo, desc, catelog_id, sort_order, is_private)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(sanitizedName, sanitizedUrl, sanitizedLogo, sanitizedDesc, catelogId, sortOrderValue, isPrivateValue).run();

    return jsonResponse({
      code: 201,
      message: 'Config created successfully',
      insert
    }, 201);
  } catch (e) {
    return errorResponse(`Failed to create config: ${e.message}`, 500);
  }
}
