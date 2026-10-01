import { redirect } from 'next/navigation';

// The dashboard's gate sends signed-out visitors on to /login, so one hop covers
// both cases without a client-side check here.
export default function Home() {
  redirect('/dashboard');
}
