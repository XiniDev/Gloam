/**
 * The combat's summary as the toast shows it (SPEC §8.12, AC-CMB-07; critic P8 r1 #20): who went down, then a row per
 * creature that dealt or took damage — dealt and taken in columns of figures.
 */
export function CombatSummary({
  downed,
  tally,
}: {
  downed: string[];
  tally: { name: string; dealt: number; taken: number }[];
}) {
  return (
    <div className="flex flex-col gap-1.5 [text-wrap:pretty]" data-testid="combat-summary">
      {downed.length ? (
        <p className="text-13 text-bone">
          <span className="text-muted">Down:</span> {downed.join(", ")}
        </p>
      ) : null}
      {tally.length ? (
        <table className="w-full text-12">
          <thead>
            <tr className="caps text-fog">
              <th className="pb-0.5 text-left font-normal">Creature</th>
              <th className="pb-0.5 pl-3 text-right font-normal">Dealt</th>
              <th className="pb-0.5 pl-3 text-right font-normal">Took</th>
            </tr>
          </thead>
          <tbody>
            {tally.map((t) => (
              <tr key={t.name} className="text-bone">
                <td className="max-w-[12rem] truncate pr-2">{t.name}</td>
                <td className="tabular pl-3 text-right">{t.dealt}</td>
                <td className="tabular pl-3 text-right">{t.taken}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-12 text-muted">No damage was dealt.</p>
      )}
    </div>
  );
}
