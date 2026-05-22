import { useSearchParams } from 'react-router-dom'
import { SignIn } from '@clerk/clerk-react'

export default function SignInPage() {
  const [searchParams] = useSearchParams()
  const redirectUrl    = searchParams.get('redirect_url') || '/dashboard'

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
      {/* Logo */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-3 inline-block">
        <img
          src="/logo.png"
          alt="Life Warrior Coaching"
          className="h-12 object-contain"
          onError={e => { e.currentTarget.style.display = 'none' }}
        />
      </div>

      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl={redirectUrl}
        appearance={{
          elements: {
            socialButtonsRoot: { display: 'none' },
            socialButtons:     { display: 'none' },
            dividerRow:        { display: 'none' },
          },
        }}
      />
    </div>
  )
}
