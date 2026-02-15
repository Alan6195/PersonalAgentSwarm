import { query } from '../db';

export interface WeddingDataResult {
  actionsTaken: boolean;
  actions: string[];
  result: string;
  originalResponse: string;
}

/**
 * Parse and execute all [WEDDING_DATA]...[/WEDDING_DATA] blocks in agent response.
 * Allows the wedding-planner agent to create/update vendors, budget items, and timeline entries.
 */
export async function processWeddingDataActions(
  agentResponse: string,
  taskId?: number
): Promise<WeddingDataResult> {
  const blockRegex = /\[WEDDING_DATA\]([\s\S]*?)\[\/WEDDING_DATA\]/g;
  const blocks: { full: string; body: string }[] = [];
  let match;

  while ((match = blockRegex.exec(agentResponse)) !== null) {
    blocks.push({ full: match[0], body: match[1] });
  }

  if (blocks.length === 0) {
    return {
      actionsTaken: false,
      actions: [],
      result: agentResponse,
      originalResponse: agentResponse,
    };
  }

  let modifiedResponse = agentResponse;
  const actions: string[] = [];

  for (const block of blocks) {
    const fields = parseFields(block.body);
    const action = fields.action || '';
    let replacement = '';

    try {
      switch (action) {
        case 'add_vendor': {
          const name = fields.name;
          const category = fields.category || 'other';
          if (!name) {
            replacement = '\n\n(Error: add_vendor requires name)';
            break;
          }
          const [vendor] = await query(
            `INSERT INTO wedding_vendors (name, category, contact_name, email, phone, status, cost_estimate, notes, next_action, next_action_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, name, status`,
            [
              name,
              category,
              fields.contact_name || null,
              fields.email || null,
              fields.phone || null,
              fields.status || 'researching',
              fields.cost_estimate ? Math.round(parseFloat(fields.cost_estimate) * 100) : null,
              fields.notes || null,
              fields.next_action || null,
              fields.next_action_date || null,
            ]
          );
          replacement = `\n\nAdded vendor: ${vendor.name} (${category}, ${vendor.status}) [ID: ${vendor.id}]`;
          actions.push(`add_vendor: ${name}`);
          console.log(`[WeddingData] Added vendor: ${name} (${category})`);
          break;
        }

        case 'update_vendor': {
          const id = fields.vendor_id || fields.id;
          if (!id) {
            replacement = '\n\n(Error: update_vendor requires vendor_id)';
            break;
          }

          const setClauses: string[] = [];
          const values: any[] = [];
          let idx = 1;

          const allowedFields: Record<string, (v: string) => any> = {
            name: (v) => v,
            category: (v) => v,
            contact_name: (v) => v,
            email: (v) => v,
            phone: (v) => v,
            status: (v) => v,
            cost_estimate: (v) => Math.round(parseFloat(v) * 100),
            cost_actual: (v) => Math.round(parseFloat(v) * 100),
            notes: (v) => v,
            next_action: (v) => v,
            next_action_date: (v) => v,
          };

          for (const [key, transform] of Object.entries(allowedFields)) {
            if (fields[key] !== undefined) {
              setClauses.push(`${key} = $${idx++}`);
              values.push(transform(fields[key]));
            }
          }

          if (setClauses.length === 0) {
            replacement = '\n\n(Error: update_vendor has no fields to update)';
            break;
          }

          setClauses.push('updated_at = NOW()');
          values.push(parseInt(id));

          const [updated] = await query(
            `UPDATE wedding_vendors SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, name, status`,
            values
          );

          if (updated) {
            replacement = `\n\nUpdated vendor #${updated.id}: ${updated.name} (${updated.status})`;
            actions.push(`update_vendor: #${id}`);
            console.log(`[WeddingData] Updated vendor #${id}`);
          } else {
            replacement = `\n\n(Vendor #${id} not found)`;
          }
          break;
        }

        case 'add_budget': {
          const item = fields.item;
          const category = fields.category || 'other';
          if (!item) {
            replacement = '\n\n(Error: add_budget requires item)';
            break;
          }
          const [budget] = await query(
            `INSERT INTO wedding_budget (category, item, estimated_cents, actual_cents, paid, vendor_id, due_date, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, item`,
            [
              category,
              item,
              fields.estimated ? Math.round(parseFloat(fields.estimated) * 100) : 0,
              fields.actual ? Math.round(parseFloat(fields.actual) * 100) : 0,
              fields.paid === 'true',
              fields.vendor_id ? parseInt(fields.vendor_id) : null,
              fields.due_date || null,
              fields.notes || null,
            ]
          );
          replacement = `\n\nAdded budget item: ${budget.item} [ID: ${budget.id}]`;
          actions.push(`add_budget: ${item}`);
          console.log(`[WeddingData] Added budget item: ${item}`);
          break;
        }

        case 'add_timeline': {
          const title = fields.title;
          const date = fields.date;
          if (!title || !date) {
            replacement = '\n\n(Error: add_timeline requires title and date)';
            break;
          }
          const [tl] = await query(
            `INSERT INTO wedding_timeline (title, date, category, vendor_id, notes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, title`,
            [
              title,
              date,
              fields.category || 'milestone',
              fields.vendor_id ? parseInt(fields.vendor_id) : null,
              fields.notes || null,
            ]
          );
          replacement = `\n\nAdded timeline event: ${tl.title} [ID: ${tl.id}]`;
          actions.push(`add_timeline: ${title}`);
          console.log(`[WeddingData] Added timeline: ${title} on ${date}`);
          break;
        }

        case 'complete_timeline': {
          const id = fields.timeline_id || fields.id;
          if (!id) {
            replacement = '\n\n(Error: complete_timeline requires timeline_id)';
            break;
          }
          const [tl] = await query(
            `UPDATE wedding_timeline SET completed = true WHERE id = $1 RETURNING id, title`,
            [parseInt(id)]
          );
          if (tl) {
            replacement = `\n\nCompleted timeline event: ${tl.title}`;
            actions.push(`complete_timeline: ${tl.title}`);
          } else {
            replacement = `\n\n(Timeline #${id} not found)`;
          }
          break;
        }

        case 'list_vendors': {
          const vendors = await query(
            `SELECT id, name, category, status, cost_estimate, next_action FROM wedding_vendors ORDER BY name`
          );
          const formatted = vendors.map((v: any) =>
            `- [${v.id}] ${v.name} (${v.category}, ${v.status})${v.cost_estimate ? ` $${(v.cost_estimate / 100).toFixed(2)}` : ''}${v.next_action ? ` | Next: ${v.next_action}` : ''}`
          ).join('\n');
          replacement = `\n\nWedding Vendors (${vendors.length}):\n${formatted || '(none)'}`;
          actions.push('list_vendors');
          break;
        }

        default:
          replacement = `\n\n(Unknown wedding data action: ${action})`;
      }
    } catch (err) {
      replacement = `\n\n(Wedding data action "${action}" failed: ${(err as Error).message})`;
      console.error(`[WeddingData] Action "${action}" failed:`, (err as Error).message);
    }

    modifiedResponse = modifiedResponse.replace(block.full, replacement);
  }

  return {
    actionsTaken: actions.length > 0,
    actions,
    result: modifiedResponse.trim(),
    originalResponse: agentResponse,
  };
}

// Parse key: value fields from a block body
function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = body.trim().split('\n');

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();
    if (key) fields[key] = value;
  }

  return fields;
}
