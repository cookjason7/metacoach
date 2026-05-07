import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.jsx'

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

function MissingKeyScreen() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white border border-amber-200 rounded-2xl shadow-sm p-8 max-w-md w-full">
        <div className="text-amber-500 text-2xl mb-3">⚠</div>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">Clerk key not configured</h1>
        <p className="text-sm text-gray-500 mb-5">
          Create <code className="bg-gray-100 px-1 rounded text-xs">client/.env.local</code> with
          your Clerk publishable key to start the app.
        </p>
        <pre className="bg-gray-900 text-[#E8670A] text-xs rounded-lg p-4 overflow-x-auto">
          VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
        </pre>
        <p className="text-xs text-gray-400 mt-4">
          Get your key from{' '}
          <span className="text-gray-600 font-medium">clerk.com</span> → your app → API Keys.
          Vite will hot-reload once the file is saved.
        </p>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {publishableKey ? (
      <ClerkProvider publishableKey={publishableKey}>
        <App />
      </ClerkProvider>
    ) : (
      <MissingKeyScreen />
    )}
  </StrictMode>,
)
