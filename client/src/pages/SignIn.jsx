import { SignIn } from '@clerk/clerk-react'

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl="/dashboard"
        appearance={{
          // Hide all social/OAuth provider buttons.
          // Google OAuth is not configured and shows "Error 400: invalid_request".
          // Remove this appearance override once OAuth providers are properly set up
          // in the Clerk Dashboard with valid client IDs.
          elements: {
            socialButtonsRoot:  { display: 'none' },
            socialButtons:      { display: 'none' },
            dividerRow:         { display: 'none' },
          },
        }}
      />
    </div>
  )
}
