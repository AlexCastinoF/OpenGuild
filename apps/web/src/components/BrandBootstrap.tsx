import { useEffect } from 'react';
import { useBrandStore } from '../store/brand';

/** Carrega marca pública e aplica title/favicon. */
export function BrandBootstrap() {
  const load = useBrandStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return null;
}
