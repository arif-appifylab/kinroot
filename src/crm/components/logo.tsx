import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';

/** The brand's logo if one is uploaded, otherwise the default sprout mark. */
export function LogoMark({className}: {className?: string}) {
  const brand = useBrand();
  if (brand.logo) {
    return <img src={brand.logo} alt="" className={cn('size-9 shrink-0 rounded-xl object-contain', className)} />;
  }
  return (
    <span className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-glow', className)}>
      {/* Default mark: a sprout above its roots. */}
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 16V9" />
        <path d="M12 10.5C12 7 14.2 4.5 18 4.5c0 3.6-2.4 6-6 6Z" fill="currentColor" fillOpacity="0.25" />
        <path d="M12 12C12 9.3 10.2 7.2 7 7.2c0 2.8 2 4.8 5 4.8Z" fill="currentColor" fillOpacity="0.25" />
        <path d="M5.5 16h13" />
        <path d="M12 16v4M12 18l-3 2.5M12 18l3 2.5" />
      </svg>
    </span>
  );
}

export function Logo({light = false}: {light?: boolean}) {
  const brand = useBrand();
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark />
      <span className={cn('text-lg font-extrabold tracking-tight', light ? 'text-white' : 'text-slate-900')}>{brand.name}</span>
    </span>
  );
}
