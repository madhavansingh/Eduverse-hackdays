import { useState } from 'react';
import { DashboardLayout } from '@/layouts/DashboardLayout';
import { Button } from '@/components/ui/button';
import {
  Crown,
  Check,
  Sparkles,
  ShieldCheck,
  Info,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export function SubscriptionPage() {
  const { user } = useAuth();
  const [showModal, setShowModal] = useState(false);

  const plans = [
    {
      name: 'Free Student',
      price: '$0',
      period: 'forever',
      description: 'Essential AI study tools for everyday learning',
      features: [
        'Up to 10 Study Sets',
        'Standard AI Flashcard Generation',
        'Basic AI Tutor Chat',
        'Spaced Repetition Review',
        'Community Support',
      ],
      current: false,
      buttonText: 'Current Base Plan',
      buttonVariant: 'outline' as const,
    },
    {
      name: 'Eduverse Pro',
      price: '$9.99',
      period: 'per month',
      popular: true,
      description: 'Full unlimited access to all Gemini 2.5 AI features',
      features: [
        'Unlimited Study Sets & Flashcards',
        'Gemini 2.5 Pro Multi-Agent Problem Solver',
        'Exam Clone PDF Generator & Practice',
        'Deep Academic Research & Synthesis',
        'Teach-Back Feynman Tutor',
        'Unlimited AI Chat & Multimodal Vision OCR',
        'Priority 24/7 AI Processing',
      ],
      current: true,
      buttonText: 'Currently Active (Pro Beta)',
      buttonVariant: 'default' as const,
    },
    {
      name: 'Institution / Campus',
      price: 'Custom',
      period: 'per seat / year',
      description: 'Dedicated AI models, admin analytics & LMS integrations',
      features: [
        'Everything in Pro Plan',
        'Canvas & Blackboard LMS Integration',
        'Classroom Live Quiz Host Dashboard',
        'Group Analytics & Progress Tracking',
        'Dedicated SLA & Custom AI Fine-Tuning',
      ],
      current: false,
      buttonText: 'Contact Sales',
      buttonVariant: 'outline' as const,
    },
  ];

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-8 p-4 md:p-6">
        {/* Header Banner */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-green-600 via-emerald-600 to-teal-600 text-white p-8 md:p-10 shadow-xl">
          <div className="relative z-10 max-w-2xl space-y-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/20 backdrop-blur-md text-xs font-bold uppercase tracking-wider">
              <Crown className="w-4 h-4 text-amber-300" />
              Pro Beta Access Included
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">
              Subscription & Membership
            </h1>
            <p className="text-green-50 text-sm md:text-base leading-relaxed">
              Welcome, <span className="font-semibold">{user?.name || 'Student'}</span>! You currently have complimentary <span className="font-bold underline decoration-amber-300">Pro Beta Access</span> to test all Google Gemini 2.5 powered features.
            </p>
          </div>
          <div className="absolute -right-10 -bottom-10 opacity-10 pointer-events-none">
            <Crown className="w-80 h-80" />
          </div>
        </div>

        {/* Info Callout */}
        <div className="flex items-start gap-4 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-900 dark:text-blue-200">
          <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
          <div className="text-sm space-y-1">
            <p className="font-semibold">Hackathon Special Access</p>
            <p className="text-muted-foreground">
              All AI features (Problem Solver, Exam Clone, Deep Research, Teach-Back, AI Chat) are fully unlocked for testing without rate limits or paywalls.
            </p>
          </div>
        </div>

        {/* Pricing Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((plan, i) => (
            <div
              key={i}
              className={`relative rounded-2xl p-6 flex flex-col justify-between transition-all bg-card border ${
                plan.popular
                  ? 'border-green-500 shadow-xl shadow-green-500/10 ring-2 ring-green-500/20'
                  : 'border-border shadow-sm'
              }`}
            >
              {plan.popular && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-gradient-to-r from-green-600 to-emerald-600 text-white text-xs font-bold shadow-md flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  Recommended
                </div>
              )}

              <div>
                <div className="mb-4">
                  <h3 className="text-xl font-bold">{plan.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{plan.description}</p>
                </div>

                <div className="mb-6 flex items-baseline gap-1">
                  <span className="text-4xl font-black">{plan.price}</span>
                  <span className="text-xs text-muted-foreground">{plan.period}</span>
                </div>

                <ul className="space-y-3 mb-6">
                  {plan.features.map((feat, idx) => (
                    <li key={idx} className="flex items-center gap-2.5 text-xs">
                      <div className="w-4 h-4 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
                        <Check className="w-3 h-3 text-green-500" />
                      </div>
                      <span>{feat}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Button
                variant={plan.buttonVariant}
                className={`w-full font-bold ${
                  plan.popular ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white hover:from-green-700 hover:to-emerald-700 shadow-md' : ''
                }`}
                onClick={() => setShowModal(true)}
              >
                {plan.current ? (
                  <>
                    <ShieldCheck className="w-4 h-4 mr-2" />
                    {plan.buttonText}
                  </>
                ) : (
                  plan.buttonText
                )}
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Coming Soon Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 animate-in fade-in zoom-in duration-200">
            <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center mx-auto text-green-500">
              <Crown className="w-6 h-6" />
            </div>
            <div className="text-center space-y-2">
              <h3 className="text-xl font-bold">Premium Payments Coming Soon</h3>
              <p className="text-sm text-muted-foreground">
                Stripe payment integration will be enabled in our upcoming production release.
              </p>
              <div className="p-3 rounded-lg bg-muted text-xs font-medium text-foreground">
                🎉 Good news! All features are currently FREE during the beta period. Enjoy unlimited access to Eduverse.
              </div>
            </div>
            <Button
              onClick={() => setShowModal(false)}
              className="w-full bg-green-500 hover:bg-green-600 font-bold"
            >
              Continue Exploring Eduverse
            </Button>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

export default SubscriptionPage;
