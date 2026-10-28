export function isDecimalQuantityAllowed(item: any): boolean {
  return Number(item?.decimalEnabled || 0) === 1;
}

export function assertItemQuantityPrecision(item: any, value: unknown, fieldLabel = 'Quantity'): void {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${fieldLabel} must be a valid number for ${item?.name || 'item'}`);
  if (!isDecimalQuantityAllowed(item) && Math.abs(n - Math.round(n)) > 0.0000001) {
    throw new Error(`${item?.name || 'Item'} does not allow decimal quantity. Enter a whole number for ${fieldLabel}.`);
  }
}

export function assertDocumentItemQuantities(item: any, line: any): void {
  assertItemQuantityPrecision(item, line?.quantity ?? 0, 'Quantity');
  if (line?.secondaryQuantity !== undefined && line?.secondaryQuantity !== null && line?.secondaryQuantity !== '') {
    assertItemQuantityPrecision(item, line.secondaryQuantity, 'Secondary quantity');
  }
  if (line?.freeQuantity !== undefined && line?.freeQuantity !== null && line?.freeQuantity !== '') {
    assertItemQuantityPrecision(item, line.freeQuantity, 'Free quantity');
  }
}



