import { faMinus, faPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';

interface FaqItem {
  question: string;
  answer: string;
}

const faqItems: FaqItem[] = [
  {
    question: 'Who is Cap for?',
    answer: 'Cap is designed for individuals, teams, and businesses who need an easy-to-use screen recording and sharing tool.'
  },
  {
    question: 'Which platforms does Cap support?',
    answer: 'Cap supports Windows, macOS, and Linux. Our web application works on all major browsers including Chrome, Firefox, Safari, and Edge.'
  },
  {
    question: 'How much does it cost?',
    answer: 'Cap offers a free version for personal use. You can upgrade to Cap Pro for just $9/month to unlock unlimited cloud storage, unlimited recording length, custom domain support, advanced team features, password-protected videos, analytics, and priority support. We also offer commercial licenses and self-hosted options for businesses.'
  },
  {
    question: 'What makes Cap different from Loom?',
    answer: 'Cap focuses on simplicity, performance, and privacy. Unlike Loom, we offer a self-hosted option and more affordable pricing for teams while maintaining all the essential features you need.'
  },
  {
    question: 'Can I self-host Cap?',
    answer: 'Yes! Cap offers self-hosted options for businesses that require complete control over their data and infrastructure.'
  },
  {
    question: 'Is there a commercial license available?',
    answer: 'Yes, we offer commercial licenses for businesses with custom pricing based on team size and needs. Contact our sales team for more information.'
  },
  {
    question: 'What happens after the beta period ends?',
    answer: 'After the beta period, all beta users will be offered a special discount to continue using Cap Pro. Your existing recordings and data will remain accessible.'
  }
];

const Faq = () => {
  const [openIndex, setOpenIndex] = useState<number | null>(null); // Default to the 'How much does it cost?' question

  const toggleFaq = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
      <div className="mx-auto max-w-[1000px] px-5 my-[150px] md:my-[200px] lg:my-[250px]">
        <h2 className="mb-10 text-4xl text-gray-12">FAQ</h2>
        <div className="space-y-4">
          {faqItems.map((item, index) => (
            <div 
              key={index}
              className={clsx("rounded-xl overflow-hidde border border-gray-5",
                openIndex === index 
                  ? 'bg-blue-500 text-white' 
                  : 'bg-gray-1 hover:bg-gray-3 text-gray-12',
              "transition-colors duration-200")}
            >
              <button
                className="flex justify-between items-center px-6 py-4 w-full text-left"
                onClick={() => toggleFaq(index)}
              >
                <p className={clsx("text-lg font-medium", openIndex === index ? "text-gray-1" : "text-gray-12")}>{item.question}</p>
                {openIndex === index ? (
                  <FontAwesomeIcon icon={faMinus} className="flex-shrink-0 w-5 h-5 text-gray-1" />
                ) : (
                  <FontAwesomeIcon icon={faPlus} className="flex-shrink-0 w-5 h-5" />
                )}
              </button>
              
              <AnimatePresence>
                {openIndex === index && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="overflow-hidden"
                  >
                    <p className="px-6 pb-4 text-gray-3">
                      {item.answer}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
  );
};

export default Faq;