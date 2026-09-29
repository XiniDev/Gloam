/**
 * The demo's token art, drawn by code (SPEC §8.24: no external or uploaded assets): SVG paths rendered to PNG by the
 * server, then put through the ordinary upload pipeline like any picture.
 */

/** A stylised goblin head: big ears, a heavy brow, yellow eyes and a toothy grin, in verdigris. */
export const GOBLIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="512" height="512">
  <defs>
    <radialGradient id="skin" cx="50%" cy="42%" r="60%">
      <stop offset="0%" stop-color="#8FB77A"/>
      <stop offset="70%" stop-color="#5E8A4E"/>
      <stop offset="100%" stop-color="#3C5E33"/>
    </radialGradient>
    <radialGradient id="eye" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFF3A8"/>
      <stop offset="100%" stop-color="#E0A92B"/>
    </radialGradient>
  </defs>
  <rect width="256" height="256" fill="#2A2320"/>
  <path d="M28 96 L86 118 L78 150 Z" fill="#4E7A42" stroke="#1E2A1A" stroke-width="5" stroke-linejoin="round"/>
  <path d="M228 96 L170 118 L178 150 Z" fill="#4E7A42" stroke="#1E2A1A" stroke-width="5" stroke-linejoin="round"/>
  <path d="M40 104 L78 122 L74 138 Z" fill="#C98E8E" opacity="0.55"/>
  <path d="M216 104 L178 122 L182 138 Z" fill="#C98E8E" opacity="0.55"/>
  <path d="M128 42 C184 42 206 86 204 132 C202 186 170 220 128 220 C86 220 54 186 52 132 C50 86 72 42 128 42 Z"
        fill="url(#skin)" stroke="#1E2A1A" stroke-width="6"/>
  <path d="M72 104 C92 88 112 92 122 104 L118 112 C104 104 88 104 76 114 Z" fill="#2E4527"/>
  <path d="M184 104 C164 88 144 92 134 104 L138 112 C152 104 168 104 180 114 Z" fill="#2E4527"/>
  <ellipse cx="98" cy="126" rx="15" ry="11" fill="url(#eye)" stroke="#1E2A1A" stroke-width="4"/>
  <ellipse cx="158" cy="126" rx="15" ry="11" fill="url(#eye)" stroke="#1E2A1A" stroke-width="4"/>
  <ellipse cx="100" cy="127" rx="4" ry="8" fill="#1A1410"/>
  <ellipse cx="156" cy="127" rx="4" ry="8" fill="#1A1410"/>
  <path d="M120 140 C124 156 132 156 136 140 C134 152 122 152 120 140 Z" fill="#3C5E33" stroke="#1E2A1A" stroke-width="3"/>
  <path d="M84 172 C104 196 152 196 172 172 C160 184 96 184 84 172 Z" fill="#241A16" stroke="#1E2A1A" stroke-width="4"/>
  <path d="M98 180 L104 192 L110 182 Z M146 182 L152 192 L158 180 Z M122 184 L128 196 L134 184 Z" fill="#EDE3C8"/>
</svg>`;

/** The Crypt Warden: a horned helm with two cold lights for eyes, in old bronze. */
export const WARDEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="512" height="512">
  <defs>
    <linearGradient id="bronze" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#C9A14A"/>
      <stop offset="55%" stop-color="#8A6A2E"/>
      <stop offset="100%" stop-color="#4E3A18"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#E8FBFF"/>
      <stop offset="45%" stop-color="#7FD3E6"/>
      <stop offset="100%" stop-color="#7FD3E6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="256" height="256" fill="#1C1A1E"/>
  <path d="M60 92 C30 70 26 40 40 22 C46 50 64 64 84 72 Z" fill="#DCCFB0" stroke="#2A2014" stroke-width="5"/>
  <path d="M196 92 C226 70 230 40 216 22 C210 50 192 64 172 72 Z" fill="#DCCFB0" stroke="#2A2014" stroke-width="5"/>
  <path d="M128 50 C180 50 204 86 204 128 L204 176 C204 206 176 224 128 230 C80 224 52 206 52 176 L52 128 C52 86 76 50 128 50 Z"
        fill="url(#bronze)" stroke="#2A2014" stroke-width="6"/>
  <path d="M128 52 L128 150" stroke="#5E4620" stroke-width="10"/>
  <path d="M66 118 L190 118 L186 146 L140 150 L128 176 L116 150 L70 146 Z" fill="#141015" stroke="#2A2014" stroke-width="5" stroke-linejoin="round"/>
  <circle cx="98" cy="132" r="18" fill="url(#glow)"/>
  <circle cx="158" cy="132" r="18" fill="url(#glow)"/>
  <circle cx="98" cy="132" r="5" fill="#F4FEFF"/>
  <circle cx="158" cy="132" r="5" fill="#F4FEFF"/>
  <path d="M84 190 L172 190 M92 204 L164 204" stroke="#4E3A18" stroke-width="6" stroke-linecap="round"/>
  <circle cx="72" cy="176" r="5" fill="#E7C66E"/><circle cx="184" cy="176" r="5" fill="#E7C66E"/>
</svg>`;
