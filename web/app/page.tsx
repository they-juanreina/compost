// Home: lists seeds. Reads .compost/state.sqlite server-side (wired via a
// server action); shown here as the landing shell.
export default function Home() {
  return (
    <div>
      <h1>Seeds</h1>
      <p>
        Open a seed to work with its sessions, highlights, codes, and themes. Run{' '}
        <code>compost serve</code> from a directory containing <code>Seeds/</code>.
      </p>
      <ul>
        <li>
          <a href="/seeds/sample">sample</a> — the bundled sample corpus
        </li>
      </ul>
    </div>
  )
}
