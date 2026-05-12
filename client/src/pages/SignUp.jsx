import { SignUp } from '@clerk/clerk-react'

export default function SignUpPage() {
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

      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/dashboard"
        appearance={{
          elements: {
            socialButtonsRoot:       { display: 'none' },
            socialButtons:           { display: 'none' },
            dividerRow:              { display: 'none' },
            // Hide first/last name fields — name is collected in Health Assessment
            formFieldRow__firstName: { display: 'none' },
            formFieldRow__lastName:  { display: 'none' },
          },
        }}
      />
    </div>
  )
}
