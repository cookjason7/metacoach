import { Link } from 'react-router-dom'

export default function Login() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">MetaCoach</h1>
        <p className="text-sm text-gray-500 mb-8">Your AI nutrition &amp; fitness coach</p>

        <div className="space-y-3">
          <button className="w-full bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-medium hover:bg-[#c45e09] transition-colors">
            Sign in with Clerk
          </button>
          <p className="text-xs text-center text-gray-400">
            Authentication via Clerk — coming soon
          </p>
        </div>

        <div className="mt-6 pt-6 border-t border-gray-100 text-center">
          <Link
            to="/dashboard"
            className="text-xs text-[#E8670A] hover:underline"
          >
            Skip to dashboard (dev only)
          </Link>
        </div>
      </div>
    </div>
  )
}
