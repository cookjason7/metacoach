import { Link } from 'react-router-dom'

export default function About() {
  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-8 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-4">
          <Link to="/about" className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="Life Warrior Coaching"
              className="h-11 w-auto object-contain"
              onError={e => { e.currentTarget.style.display = 'none' }}
            />
          </Link>
          <Link
            to="/sign-in"
            className="rounded-lg bg-[#1e2a3a] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#111827]"
          >
            Log In
          </Link>
        </header>

        <section className="flex flex-1 flex-col justify-center py-12">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="mb-3 text-xs font-bold uppercase tracking-widest text-[#f97316]">
              Life Warrior Coaching
            </p>
            <h1 className="mb-4 text-3xl font-bold tracking-normal text-gray-950 sm:text-4xl">
              Life Warrior Coaching App
            </h1>
            <p className="max-w-2xl text-base leading-7 text-gray-600">
              Life Warrior Coaching App helps clients track nutrition, hydration, habits, progress, check-ins, messaging, and coaching support.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/privacy"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-[#f97316] hover:text-[#c45e09]"
              >
                Privacy Policy
              </Link>
              <Link
                to="/terms"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-[#f97316] hover:text-[#c45e09]"
              >
                Terms of Service
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
