import { Link } from 'react-router-dom'

export default function Privacy() {
  return (
    <div className="min-h-screen bg-white py-8 px-4 sm:px-6">
    <div className="w-full max-w-2xl mx-auto pb-10">
      <Link to="/settings" className="text-sm text-[#E8670A] hover:text-[#c45e09] mb-6 inline-block">
        ← Back to Settings
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-4">Last updated: May 2025</p>

      <div className="space-y-8 text-sm text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">1. Information We Collect</h2>
          <p className="mb-2">When you use WarriorFIT AI, we collect the following types of information:</p>
          <ul className="list-disc list-inside space-y-1 text-gray-600 pl-2">
            <li>Account information (name, email address)</li>
            <li>Health and wellness data you log (meals, steps, weight, sleep, workouts)</li>
            <li>Health assessment responses and body measurements</li>
            <li>Progress photos you choose to upload</li>
            <li>Messages and journal entries</li>
            <li>Usage data and device information</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">2. How We Use Your Information</h2>
          <p className="mb-2">We use your information to:</p>
          <ul className="list-disc list-inside space-y-1 text-gray-600 pl-2">
            <li>Provide and improve the coaching and wellness features of the Service</li>
            <li>Allow your assigned coach to support your health goals</li>
            <li>Personalize your experience and track your progress over time</li>
            <li>Send you relevant notifications and updates about your plan</li>
            <li>Ensure the security and reliability of the Service</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">3. Information Sharing</h2>
          <p>
            We do not sell your personal information to third parties. Your health data may be shared with
            your assigned coach and, where applicable, authorized members of your coaching team. We may share
            information with service providers who help us operate the platform (e.g., cloud infrastructure,
            authentication), subject to confidentiality obligations.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">4. Connected Apps</h2>
          <p>
            If you connect a third-party health app (such as Google Health), we receive data from that service
            in accordance with its own privacy policies and the permissions you grant. You can disconnect these
            integrations at any time from Settings.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">5. Data Security</h2>
          <p>
            We take reasonable technical and organizational measures to protect your personal information.
            However, no method of transmission or storage is completely secure. If you have reason to believe
            your account has been compromised, please contact us immediately.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">6. Data Retention</h2>
          <p>
            We retain your information for as long as your account is active or as needed to provide the
            Service. You may request deletion of your account and associated data by contacting us. Some
            data may be retained for a limited period as required by applicable law or for legitimate
            business purposes.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">7. Your Rights</h2>
          <p>
            Depending on your location, you may have rights to access, correct, or delete your personal
            information. To exercise these rights or ask questions about your data, please contact us.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-2">8. Contact</h2>
          <p>
            For privacy questions or data requests, contact us at{' '}
            <a href="mailto:support@lwcvip.com" className="text-[#E8670A] hover:text-[#c45e09]">
              support@lwcvip.com
            </a>.
          </p>
        </section>
      </div>
    </div>
    </div>
  )
}
