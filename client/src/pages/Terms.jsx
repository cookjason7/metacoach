import { Link } from 'react-router-dom'

export default function Terms() {
  return (
    <div className="w-full max-w-2xl mx-auto pb-10">
      <Link to="/settings" className="text-sm text-[#E8670A] hover:text-[#c45e09] mb-6 inline-block">
        ← Back to Settings
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-4">Last updated: May 2025</p>

      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-8">
        <p className="text-xs text-amber-700 font-medium">
          Placeholder — this content should be reviewed by legal counsel before launch.
        </p>
      </div>

      <div className="space-y-8 text-sm text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">1. Acceptance of Terms</h2>
          <p>
            By accessing or using Meta Coach ("the Service"), you agree to be bound by these Terms of Service.
            If you do not agree to these terms, please do not use the Service.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">2. Description of Service</h2>
          <p>
            Meta Coach is a health and wellness coaching platform that provides nutrition tracking, habit monitoring,
            fitness logging, and coaching support. The Service is intended for informational and personal wellness
            purposes only and does not constitute medical advice.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">3. Account Responsibilities</h2>
          <p>
            You are responsible for maintaining the confidentiality of your account credentials and for all activity
            that occurs under your account. You agree to provide accurate and complete information when creating
            your account and to keep that information up to date.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">4. Acceptable Use</h2>
          <p className="mb-2">You agree not to:</p>
          <ul className="list-disc list-inside space-y-1 text-gray-600 pl-2">
            <li>Use the Service for any unlawful purpose</li>
            <li>Share your account with others or allow unauthorized access</li>
            <li>Upload or transmit harmful, offensive, or misleading content</li>
            <li>Attempt to interfere with or disrupt the Service</li>
            <li>Reverse engineer or copy any part of the Service</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">5. Health Disclaimer</h2>
          <p>
            The content provided through Meta Coach, including coaching messages, nutrition plans, and fitness
            recommendations, is for general wellness purposes only. Always consult a qualified healthcare
            professional before making significant changes to your diet, exercise routine, or health practices.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">6. Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, Meta Coach and its operators shall not be liable for any
            indirect, incidental, special, or consequential damages arising from your use of the Service.
            Your use of the Service is at your own risk.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">7. Changes to Terms</h2>
          <p>
            We may update these Terms of Service from time to time. Continued use of the Service after any
            changes constitutes your acceptance of the updated terms. We will make reasonable efforts to
            notify users of material changes.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">8. Contact</h2>
          <p>
            If you have questions about these Terms, please contact us at{' '}
            <a href="mailto:support@lwcvip.com" className="text-[#E8670A] hover:text-[#c45e09]">
              support@lwcvip.com
            </a>.
          </p>
        </section>
      </div>
    </div>
  )
}
