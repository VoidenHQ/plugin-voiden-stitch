export const StitchHelp = () => (
  <div className="space-y-4">
    <section>
      <h3 className="font-semibold mb-2 text-text">Stitch Runner</h3>
      <p className="text-sm text-comment mb-3">
        Batch-runs requests across multiple <code className="bg-accent/10 px-1 rounded text-text">.void</code> files
        and gives a single pass/fail report — instead of opening and running each file by hand.
      </p>
    </section>

    <section>
      <h4 className="font-semibold mb-2 text-text">Settings</h4>
      <ul className="list-disc list-inside space-y-1 text-sm text-comment">
        <li><strong>Include / Exclude</strong> — pick which folders to run and files to skip; Voiden auto-discovers every <code className="bg-accent/10 px-1 rounded text-text">.void</code> file inside included folders</li>
        <li><strong>Environment</strong> — which environment/variables the run uses</li>
        <li><strong>Stop on Failure</strong> — halt the whole run on the first failed request, or keep going</li>
        <li><strong>Isolate Variables</strong> — give each file its own variable scope, or share state across the whole run</li>
        <li><strong>Delay Between Files</strong> — pace requests for rate-limited APIs</li>
        <li><strong>Sequence vs. Parallel</strong> — sequential when requests depend on each other, parallel for speed</li>
      </ul>
    </section>

    <section>
      <h4 className="font-semibold mb-2 text-text">How to Use</h4>
      <ol className="list-decimal list-inside space-y-1 text-sm text-comment">
        <li>Insert with <code className="bg-accent/10 px-1 rounded text-text">/stitch</code></li>
        <li>Configure include/exclude, environment, and execution options</li>
        <li>Optionally add scenarios (multiple variable sets from CSV/JSON/YAML or inline) to run the same requests against different inputs</li>
        <li>Preview and reorder the queued files, then run</li>
        <li>Review the pass/fail breakdown, and past runs via history</li>
      </ol>
    </section>
  </div>
);
