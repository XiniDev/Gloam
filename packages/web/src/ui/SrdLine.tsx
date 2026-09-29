/**
 * The small attribution line on SRD spell and condition cards (SPEC §33.6, Appendix I): the pack and page it's from
 * and its licence, the full statement in its tooltip (About & Credits carries it too). Never a trademark (§33.6).
 */
export const SRD_ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';

export function SrdLine({ page, className = "" }: { page?: number | undefined; className?: string }) {
  return (
    <p className={`text-12 italic opacity-75 ${className}`} title={SRD_ATTRIBUTION} data-testid="srd-line">
      SRD 5.2.1{page ? `, p. ${page}` : ""} · CC-BY-4.0
    </p>
  );
}
