import { useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Star, Quote, BadgeCheck } from 'lucide-react';

interface IndianTestimonial {
  id: string;
  name: string;
  initials: string;
  role: string;
  institution: string;
  text: string;
  rating: number;
  avatarGradient: string;
}

const INDIAN_TESTIMONIALS: IndianTestimonial[] = [
  {
    id: 't1',
    name: 'Arjun Patel',
    initials: 'AP',
    role: 'B.Tech CSE',
    institution: 'IIT Bombay',
    text: 'Eduverse completely changed how I prepare for semester exams. I upload my lecture PDFs and within minutes I have organized flashcards, AI summaries, and quizzes. It saves me hours every week.',
    rating: 5,
    avatarGradient: 'from-blue-600 to-indigo-600',
  },
  {
    id: 't2',
    name: 'Priya Sharma',
    initials: 'PS',
    role: 'MBBS',
    institution: 'AIIMS New Delhi',
    text: 'Preparing for medical exams became much easier with Eduverse. The AI explanations simplify difficult concepts, and the flashcards help me revise quickly before practicals and university exams.',
    rating: 5,
    avatarGradient: 'from-emerald-600 to-teal-600',
  },
  {
    id: 't3',
    name: 'Rahul Kumar',
    initials: 'RK',
    role: 'B.Tech ECE',
    institution: 'NIT Tiruchirappalli',
    text: 'The Problem Solver is incredibly useful. Instead of searching multiple websites, I get detailed step-by-step explanations instantly. It has become part of my daily study routine.',
    rating: 5,
    avatarGradient: 'from-amber-500 to-orange-600',
  },
  {
    id: 't4',
    name: 'Sneha Nair',
    initials: 'SN',
    role: 'B.Tech AI',
    institution: 'IIIT Hyderabad',
    text: 'I use Eduverse every day for my assignments and coding subjects. The AI Chat and Learning Paths make studying much more organized and productive.',
    rating: 5,
    avatarGradient: 'from-purple-600 to-indigo-600',
  },
  {
    id: 't5',
    name: 'Ananya Verma',
    initials: 'AV',
    role: 'B.Tech Mechanical',
    institution: 'IIT Delhi',
    text: 'The Exam Clone feature is amazing for practice. Uploading previous-year papers and getting similar questions has made my revision much more effective.',
    rating: 5,
    avatarGradient: 'from-rose-500 to-pink-600',
  },
  {
    id: 't6',
    name: 'Vikramaditya Rao',
    initials: 'VR',
    role: 'MBA',
    institution: 'IIM Ahmedabad',
    text: 'Eduverse helps our study group condense complex business case studies and financial concepts into structured revision materials fast. Highly recommended for CAT and B-school prep.',
    rating: 5,
    avatarGradient: 'from-cyan-600 to-blue-600',
  },
];

function IndiaFlagSVG({ className = 'w-8 h-5.5' }: { className?: string }) {
  return (
    <svg
      className={`inline-block align-baseline rounded-[3px] shadow-xs border border-slate-200/80 overflow-hidden ${className}`}
      viewBox="0 0 30 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="30" height="6.67" fill="#FF9933" />
      <rect y="6.67" width="30" height="6.67" fill="#FFFFFF" />
      <rect y="13.33" width="30" height="6.67" fill="#128807" />
      <circle cx="15" cy="10" r="2.8" stroke="#000080" strokeWidth="0.6" fill="none" />
      <circle cx="15" cy="10" r="0.6" fill="#000080" />
      {[...Array(24)].map((_, i) => {
        const angle = (i * 360) / 24;
        const rad = (angle * Math.PI) / 180;
        const x2 = 15 + 2.8 * Math.cos(rad);
        const y2 = 10 + 2.8 * Math.sin(rad);
        return (
          <line
            key={i}
            x1="15"
            y1="10"
            x2={x2}
            y2={y2}
            stroke="#000080"
            strokeWidth="0.35"
          />
        );
      })}
    </svg>
  );
}

function StarRating({ rating = 5 }: { rating?: number }) {
  return (
    <div className="flex gap-1">
      {[...Array(5)].map((_, i) => (
        <Star
          key={i}
          className={`w-4 h-4 ${
            i < rating ? 'text-amber-400 fill-amber-400' : 'text-slate-300'
          }`}
        />
      ))}
    </div>
  );
}

function TestimonialCard({ item }: { item: IndianTestimonial }) {
  return (
    <div className="w-[320px] sm:w-[360px] lg:w-[380px] shrink-0 bg-white/95 backdrop-blur-md border border-slate-200/80 hover:border-emerald-500/30 rounded-2xl p-6 lg:p-7 flex flex-col justify-between overflow-hidden group transition-all duration-300 hover:shadow-lg hover:-translate-y-1 h-full select-none">
      <div>
        <div className="flex items-center justify-between mb-4">
          <StarRating rating={item.rating} />
          <Quote className="w-6 h-6 text-emerald-500/20 shrink-0" />
        </div>

        <p className="text-slate-700 text-sm sm:text-base leading-relaxed mb-6 font-normal">
          "{item.text}"
        </p>
      </div>

      <div className="flex items-center gap-3.5 pt-4 border-t border-slate-100">
        <div
          className={`w-11 h-11 rounded-full bg-gradient-to-br ${item.avatarGradient} flex items-center justify-center text-white text-sm font-bold ring-2 ring-white shadow-sm shrink-0`}
        >
          {item.initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="font-bold text-slate-900 text-sm truncate">
              {item.name}
            </p>
            <BadgeCheck className="w-4 h-4 text-emerald-600 shrink-0" />
          </div>
          <div className="inline-flex items-center gap-1 text-xs text-slate-500 mt-0.5 truncate">
            <span className="font-medium text-slate-700">{item.role}</span>
            <span>•</span>
            <span className="text-emerald-700 font-semibold">{item.institution}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TestimonialsSection() {
  const { t } = useTranslation();
  const [isPaused, setIsPaused] = useState(false);

  // Triple the list to make seamless continuous infinite 1-by-1 marquee
  const marqueeItems = [
    ...INDIAN_TESTIMONIALS,
    ...INDIAN_TESTIMONIALS,
    ...INDIAN_TESTIMONIALS,
  ];

  return (
    <section className="py-20 lg:py-28 relative overflow-hidden bg-slate-50/50">
      {/* Subtle Background Glows */}
      <div className="absolute inset-0 -z-10 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-background via-emerald-50/20 to-background" />
        <div className="absolute top-1/3 left-1/4 w-[500px] h-[500px] bg-gradient-to-br from-emerald-400/10 to-teal-400/10 rounded-full blur-3xl" />
      </div>

      <div className="container mx-auto px-6 sm:px-10 lg:px-16 xl:px-20 max-w-7xl mb-12">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-slate-900 mb-4">
              Loved by{' '}
              <span className="bg-gradient-to-r from-emerald-600 via-green-600 to-teal-600 bg-clip-text text-transparent inline-flex items-center gap-2">
                <span>Students Across India</span>
                <IndiaFlagSVG className="w-8 h-5.5 ml-1" />
              </span>
            </h2>

            <p className="text-slate-600 text-base sm:text-lg leading-relaxed max-w-2xl mx-auto">
              {t('testimonials.description', "Join thousands of students from India's top institutions who use Eduverse to study smarter, prepare faster, and score better.")}
            </p>
          </motion.div>
        </div>
      </div>

      {/* Continuous Marquee Slider (1-by-1 continuous smooth movement, medium-high speed, pauses on hover) */}
      <div
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        className="relative w-full overflow-hidden py-4 [mask-image:linear-gradient(to_right,transparent,black_4%,black_96%,transparent)]"
      >
        <motion.div
          className="flex gap-6 w-max"
          animate={{ x: isPaused ? undefined : ['0%', '-33.3333%'] }}
          transition={{
            ease: 'linear',
            duration: 18, // Medium-high speed smooth continuous movement
            repeat: Infinity,
          }}
        >
          {marqueeItems.map((item, idx) => (
            <TestimonialCard key={`${item.id}-${idx}`} item={item} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}
