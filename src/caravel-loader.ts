//! Loader azulejo: a caravela a navegar. SVG inline (animado por CSS via classes cl-*).
//! Fonte única para o indicador "A pensar…" do chat; o splash de arranque usa o mesmo
//! desenho/classes em index.html (escrito à mão para pintar antes do bundle).

let seq = 0;

/** Devolve o markup do tile azulejo com a caravela a navegar, ao tamanho dado. */
export function caravelLoader(size = 96): string {
  const n = ++seq;
  const cx = `cl-cx-${n}`;
  const clip = `cl-clip-${n}`;
  // vaga periódica (período 60) larga o suficiente para o drift fazer loop sem costura
  const waveA = "M-30 65 q15 -5 30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0";
  const waveB = "M-30 73 q15 -5 30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0";
  return `
<svg class="caravel-loader" width="${size}" height="${size}" viewBox="0 0 96 96" role="img" aria-label="Caravela a navegar">
  <defs>
    <symbol id="${cx}" viewBox="-50 -50 100 100">
      <path d="M -10 -15 L -30 -50 L 30 -50 L 10 -15 L 15 -10 L 50 -30 L 50 30 L 15 10 L 10 15 L 30 50 L -30 50 L -10 15 L -15 10 L -50 30 L -50 -30 L -15 -10 Z" fill="#2f6ea5"/>
      <path transform="scale(0.46)" d="M -10 -15 L -30 -50 L 30 -50 L 10 -15 L 15 -10 L 50 -30 L 50 30 L 15 10 L 10 15 L 30 50 L -30 50 L -10 15 L -15 10 L -50 30 L -50 -30 L -15 -10 Z" fill="#f4f1e9"/>
    </symbol>
    <clipPath id="${clip}"><rect x="5" y="5" width="86" height="86" rx="20"/></clipPath>
  </defs>
  <rect x="5" y="5" width="86" height="86" rx="20" fill="#f4f1e9" stroke="#1c3f73" stroke-width="4"/>
  <g clip-path="url(#${clip})">
    <path class="cl-wave-b" d="${waveB} L240 96 L-30 96 Z" fill="#1c3f73"/>
    <g class="cl-ship">
      <g transform="translate(13 0) rotate(-26 40 56)" stroke="#1c3f73" stroke-linejoin="round">
        <g stroke-width="1.4" opacity="0.8">
          <line x1="40" y1="18" x2="22" y2="52"/>
          <line x1="40" y1="18" x2="58" y2="52"/>
        </g>
        <line x1="40" y1="16" x2="40" y2="56" stroke="#1c3f73" stroke-width="3"/>
        <path d="M40 17 L55 22 L40 27 Z" fill="#d98e3c" stroke="#c8782a" stroke-width="1"/>
        <path d="M22 27 Q40 34 58 27 L61 49 Q40 56 19 49 Z" fill="#f4f1e9" stroke-width="3"/>
        <use href="#${cx}" x="31" y="33" width="16" height="16"/>
        <path d="M22 52 Q40 62 58 52 Q55 65 40 65 Q25 65 22 52 Z" fill="#2f6ea5" stroke-width="3"/>
        <path d="M22 52 Q40 62 58 52 L57 56 Q40 66 23 56 Z" fill="#6fa8d6" stroke="none"/>
      </g>
    </g>
    <path class="cl-wave-a" d="${waveA} L240 96 L-30 96 Z" fill="#2f6ea5"/>
    <path class="cl-foam" d="${waveA}" fill="none" stroke="#dbeaf4" stroke-width="3" stroke-linecap="round"/>
  </g>
  <rect x="5" y="5" width="86" height="86" rx="20" fill="none" stroke="#1c3f73" stroke-width="4"/>
</svg>`;
}
