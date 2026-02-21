import { cn } from '../utils/cn';

interface Props {
  msg: string;
  type: 'success' | 'error' | 'info';
}

export const Notification: React.FC<Props> = ({ msg, type }) => {
  const colors = {
    success: 'bg-emerald-500 border-emerald-400',
    error: 'bg-red-500 border-red-400',
    info: 'bg-blue-500 border-blue-400',
  };
  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
  };
  return (
    <div className={cn(
      'fixed top-6 right-6 z-50 flex items-center gap-3 px-5 py-3 rounded-xl border shadow-2xl text-white font-medium text-sm animate-slide-in max-w-sm',
      colors[type]
    )}>
      <span className="text-lg font-bold">{icons[type]}</span>
      <span>{msg}</span>
    </div>
  );
};
