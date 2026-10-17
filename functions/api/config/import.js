// functions/api/config/import.js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder } from '../../_middleware';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const jsonData = await request.json();
    let categoriesToImport = [];
    let sitesToImport = [];
    let isNewFormat = false;

    // Detect import format
    if (jsonData && typeof jsonData === 'object' && Array.isArray(jsonData.category) && Array.isArray(jsonData.sites)) {
      categoriesToImport = jsonData.category;
      sitesToImport = jsonData.sites;
      isNewFormat = true;
    } else if (Array.isArray(jsonData)) { // Legacy format support
      sitesToImport = jsonData;
    } else {
      return errorResponse('Invalid JSON format. Expected { "category": [...], "sites": [...] } or an array of sites.', 400);
    }

    if (sitesToImport.length === 0) {
      return jsonResponse({ code: 200, message: 'Import successful, but no sites were found to import.' });
    }

    const db = env.NAV_DB;
    const BATCH_SIZE = 100;

    // --- Category Processing ---
    const oldCatIdToNewCatIdMap = new Map(); // Maps JSON ID -> DB ID
    let categoryNameToIdMap = new Map(); // For legacy format mapping
    
    // 1. Fetch all existing categories from DB
    // We need parent_id to correctly identify subcategories
    const { results: existingDbCategories } = await db.prepare('SELECT id, catelog, parent_id FROM category').all();
    
    // Helper to find existing category by name and parent_id
    const findExistingCategory = (name, parentId) => {
        if (!existingDbCategories) return null;
        return existingDbCategories.find(c =>
            c.catelog === name &&
            (c.parent_id === parentId || (c.parent_id === null && parentId === 0))
        );
    };

    if (isNewFormat) {
        // Validate all categories first
        for (const cat of categoriesToImport) {
            if (!cat.catelog || !(cat.catelog.trim())) {
                return errorResponse("导入失败：分类数据中存在无效条目，缺少 'catelog' 名称。", 400);
            }
        }

        // Sort categories to ensure parents are processed before children (Topological Sort)
        let sortedCats = [];
        let remaining = [...categoriesToImport];
        // Set of JSON-side IDs that have been "processed" (added to sorted list). 0 is root.
        let processedJsonIds = new Set([0, '0']);
        
        let lastRemainingCount = -1;
        while(remaining.length > 0) {
            // Safety break to prevent infinite loops (e.g. cycles or missing parents)
            if (remaining.length === lastRemainingCount) {
                // No progress made? Just push the rest and handle them as best as we can (they might end up at root)
                sortedCats.push(...remaining);
                break;
            }
            lastRemainingCount = remaining.length;
            
            const [ready, notReady] = remaining.reduce((acc, cat) => {
                const pid = cat.parent_id || 0;
                if (processedJsonIds.has(pid)) {
                    acc[0].push(cat);
                } else {
                    acc[1].push(cat);
                }
                return acc;
            }, [[], []]);
            
            // Sort the ready batch by ID to keep deterministic order
            ready.sort((a, b) => (a.id || 0) - (b.id || 0));
            
            ready.forEach(cat => processedJsonIds.add(cat.id));
            sortedCats.push(...ready);
            remaining = notReady;
        }
        categoriesToImport = sortedCats;

        // Process sequentially to handle dependencies
        for (const cat of categoriesToImport) {
            const catName = (cat.catelog || '').trim();
            const jsonParentId = cat.parent_id || 0;
            
            // Resolve DB Parent ID
            let dbParentId = 0;
            if (jsonParentId !== 0) {
                if (oldCatIdToNewCatIdMap.has(jsonParentId)) {
                    dbParentId = oldCatIdToNewCatIdMap.get(jsonParentId);
                } else {
                    // Parent not found? Might be skipped or out of order.
                    // Fallback to root or handle error.
                    // If sorted correctly, this shouldn't happen unless parent is missing.
                    dbParentId = 0;
                }
            }

            // Check if exists
            const existing = findExistingCategory(catName, dbParentId);
            
            if (existing) {
                oldCatIdToNewCatIdMap.set(cat.id, existing.id);
            } else {
                // Insert new
                const sortOrder = normalizeSortOrder(cat.sort_order);
                const result = await db.prepare('INSERT INTO category (catelog, sort_order, parent_id) VALUES (?, ?, ?)')
                                       .bind(catName, sortOrder, dbParentId)
                                       .run();
                // Get the new ID
                // D1 run() returns { meta: { last_row_id: ... } } or similar depending on adapter
                // Cloudflare D1 returns meta.last_row_id
                let newId = result.meta.last_row_id;
                
                // Update local cache of existing categories so children can find this new parent
                const newCatObj = { id: newId, catelog: catName, parent_id: dbParentId };
                if (!existingDbCategories) {
                     // In case it was null
                     // existingDbCategories = [newCatObj]; // const assignment error
                } else {
                    existingDbCategories.push(newCatObj);
                }
                
                oldCatIdToNewCatIdMap.set(cat.id, newId);
            }
        }
    } else {
        if (existingDbCategories) {
             existingDbCategories.forEach(c => categoryNameToIdMap.set(c.catelog, c.id));
        }
        // Legacy format: Extract categories from the sites array itself
        const defaultCategory = 'Default';
        const categoryNames = [...new Set(sitesToImport.map(item => (item.catelog || defaultCategory).trim()))].filter(name => name);
        const newCategoryNames = categoryNames.filter(name => !categoryNameToIdMap.has(name));

        if (newCategoryNames.length > 0) {
            const insertStmts = newCategoryNames.map(name => db.prepare('INSERT INTO category (catelog) VALUES (?)').bind(name));
            await db.batch(insertStmts);
            
            // Fetch new IDs in batches
            for (let i = 0; i < newCategoryNames.length; i += BATCH_SIZE) {
                const chunk = newCategoryNames.slice(i, i + BATCH_SIZE);
                const placeholders = chunk.map(() => '?').join(',');
                const { results: newCategories } = await db.prepare(`SELECT id, catelog FROM category WHERE catelog IN (${placeholders})`).bind(...chunk).all();
                if (newCategories) {
                    newCategories.forEach(c => categoryNameToIdMap.set(c.catelog, c.id));
                }
            }
        }
    }

    // --- Site Processing ---
    // 1. Get all URLs from the import list to check for existence in one go
    const siteUrls = sitesToImport.map(item => (item.url || '').trim()).filter(url => url);
    const existingSiteUrls = new Set();
    if (siteUrls.length > 0) {
        for (let i = 0; i < siteUrls.length; i += BATCH_SIZE) {
            const chunk = siteUrls.slice(i, i + BATCH_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            const { results: existingSites } = await db.prepare(`SELECT url FROM sites WHERE url IN (${placeholders})`).bind(...chunk).all();
            if (existingSites) {
                existingSites.forEach(site => existingSiteUrls.add(site.url));
            }
        }
    }

    const siteInsertStmts = [];
    let itemsAdded = 0;
    let itemsSkipped = 0;
    const iconAPI = env.ICON_API || 'https://icons.duckduckgo.com/ip3/';

    for (const site of sitesToImport) {
        const sanitizedUrl = (site.url || '').trim();
        const sanitizedName = (site.name || '').trim();

        // Stricter validation: skip if essential fields are missing
        if (!sanitizedUrl || !sanitizedName) {
            itemsSkipped++;
            continue;
        }
        if (isNewFormat && (site.catelog_id === undefined || site.catelog_id === null)) {
            itemsSkipped++;
            continue; // Skip if catelog_id is missing in new format
        }

        // If URL already exists, skip this item as requested
        if (existingSiteUrls.has(sanitizedUrl)) {
            itemsSkipped++;
            continue;
        }

        let newCatId;
        if (isNewFormat) {
            // Map category using the old ID from the file
            newCatId = oldCatIdToNewCatIdMap.get(site.catelog_id);
        } else {
            // Map category by name for legacy format
            const catName = (site.catelog || 'Default').trim();
            newCatId = categoryNameToIdMap.get(catName);
        }

        // If category could not be mapped, skip the site
        if (!newCatId) {
            itemsSkipped++;
            continue;
        }

        // Auto-generate logo if it's missing or is a data URI
        let sanitizedLogo = (site.logo || '').trim();
        if ((!sanitizedLogo || sanitizedLogo.startsWith('data:image')) && sanitizedUrl.startsWith('http')) {
            const domain = sanitizedUrl.replace(/^https?:\/\//, '').split('/')[0];
            sanitizedLogo = `${iconAPI}${domain}${!env.ICON_API ? '.ico' : ''}`;
        }
        if (!sanitizedLogo) sanitizedLogo = null;

        const sanitizedDesc = (site.desc || '').trim() || null;
        const sortOrderValue = normalizeSortOrder(site.sort_order);

        siteInsertStmts.push(
            db.prepare('INSERT INTO sites (name, url, logo, desc, catelog_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(sanitizedName, sanitizedUrl, sanitizedLogo, sanitizedDesc, newCatId, sortOrderValue)
        );
        itemsAdded++;
    }

    // Batch insert all new sites
    if (siteInsertStmts.length > 0) {
        await db.batch(siteInsertStmts);
    }

    return jsonResponse({
        code: 201,
        message: `导入完成。成功添加 ${itemsAdded} 个书签，跳过 ${itemsSkipped} 个（已存在或数据不完整）。`
    }, 201);

  } catch (error) {
    return errorResponse(`Failed to import config: ${error.message}`, 500);
  }
}
