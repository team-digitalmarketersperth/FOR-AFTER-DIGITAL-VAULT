import { redirect } from 'next/navigation';

// The portal's gate sends signed-out visitors on to its own sign-in page.
export default function Page() {
  redirect('/trusted-contact/accounts');
}
