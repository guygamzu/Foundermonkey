'use client';

export function ScrollLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (href === '#') {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const id = href.replace('#', '');
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();

    // Temporarily unstick all panels so getBoundingClientRect returns
    // the natural document-flow position, not the stuck position.
    const panels = document.querySelectorAll<HTMLElement>('.lp-panel');
    panels.forEach(p => { p.style.position = 'relative'; });

    const top = el.getBoundingClientRect().top + window.scrollY;

    panels.forEach(p => { p.style.position = ''; });

    window.scrollTo({ top: Math.max(0, top - 72), behavior: 'smooth' });
  };

  return (
    <a href={href} onClick={handleClick} className={className}>
      {children}
    </a>
  );
}
