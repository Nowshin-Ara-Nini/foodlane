import Link from 'next/link';
export default function Forbidden() {
  return <main className="shell"><section className="panel"><h1>Access restricted</h1><p>Your account does not have permission to open this area.</p><Link className="button" href="/">Browse food</Link></section></main>;
}
