// Pure item movement classifier. Kept independent of Express/database modules so
// its business rules can be compiled and tested without loading the complete API.
export function classifyItemMovementRows(rows: any[], now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return rows.map((row: any) => {
    const created = row.createdAt ? new Date(String(row.createdAt)) : now;
    const createdStart = new Date(created.getFullYear(), created.getMonth(), created.getDate());
    const ageDays = Math.max(0, Math.floor((startOfToday.getTime() - createdStart.getTime()) / 86400000));
    const soldLast7Days = Math.max(0, Number(row.soldLast7Days || 0));
    const soldLast30Days = Math.max(0, Number(row.soldLast30Days || 0));
    let movementType: 'item_fast' | 'item_normal' | 'item_slow';
    let movementReason: string;
    if (ageDays < 7) {
      movementType = 'item_normal';
      movementReason = 'New item: 7-day grace period';
    } else if (soldLast7Days >= 3) {
      movementType = 'item_fast';
      movementReason = `${soldLast7Days} units sold in the last 7 days`;
    } else if (soldLast7Days >= 1) {
      movementType = 'item_normal';
      movementReason = `${soldLast7Days} unit${soldLast7Days === 1 ? '' : 's'} sold in the last 7 days`;
    } else {
      movementType = 'item_slow';
      movementReason = ageDays >= 30 ? `No sales for ${ageDays} days; stale stock` : 'No sales in the last 7 days';
    }
    return {
      ...row, soldLast7Days, soldLast30Days, ageDays, movementType,
      movementLabel: movementType === 'item_fast' ? 'Fast Moving' : movementType === 'item_normal' ? 'Normal' : 'Slow Moving',
      movementReason, stale: ageDays >= 30 && soldLast30Days <= 0,
    };
  });
}
