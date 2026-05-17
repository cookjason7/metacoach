export default function AiWelcome() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-8 text-center">

        <div className="w-14 h-14 rounded-full bg-[#fff7ed] flex items-center justify-center mx-auto mb-4 text-3xl">
          🎉
        </div>

        <p className="text-xs font-bold text-[#E8670A] uppercase tracking-widest mb-1">
          Life Warrior Coaching
        </p>

        <h1 className="text-xl font-bold text-gray-900 mb-3 mt-2">
          Payment confirmed!
        </h1>

        <p className="text-sm text-gray-600 leading-relaxed mb-2">
          Check your email for a setup link to create your account and get started.
        </p>

        <p className="text-xs text-gray-400 leading-relaxed mb-7">
          The email comes from Life Warrior Coaching. If you don't see it in a minute or two, check your spam folder.
        </p>

        <div className="bg-[#fff7ed] rounded-xl p-4 text-left mb-6">
          <p className="text-xs font-semibold text-[#E8670A] mb-2">What you get:</p>
          <ul className="space-y-1.5 text-xs text-gray-600">
            <li>✓ AI-powered coaching chat</li>
            <li>✓ Personalized food & nutrition tracking</li>
            <li>✓ Habit & progress tools</li>
            <li>✓ Brain Mapping & mindset resources</li>
            <li>✓ Direct messaging with the team</li>
          </ul>
        </div>

        <p className="text-xs text-gray-400">
          Questions?{' '}
          <a href="mailto:support@lwcvip.com" className="text-[#E8670A] hover:underline">
            support@lwcvip.com
          </a>
        </p>
      </div>
    </div>
  )
}
