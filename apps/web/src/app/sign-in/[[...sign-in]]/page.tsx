import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className="centered">
      <SignIn />
    </div>
  );
}
