import { AgentActivityTerminal } from '@/components/AgentActivityTerminal';
import { DebateVisualizer } from '@/components/DebateVisualizer';
import { TradeHistoryTable } from '@/components/TradeHistoryTable';

export default function GlassBoxDashboard() {
  return (
    <div className="min-h-screen bg-bg0 p-6 flex flex-col gap-6">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1">AgentOS Glass-Box</h1>
          <p className="text-txt1 text-sm">Real-time neural visualization of Multi-Agent decision making.</p>
        </div>
        <div className="flex gap-4">
            {/* Action buttons could go here */}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1 min-h-0">
        
        {/* Left Column: Debate & Trades */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          <div className="shrink-0">
            <DebateVisualizer />
          </div>
          <div className="flex-1 min-h-[300px]">
            <TradeHistoryTable />
          </div>
        </div>

        {/* Right Column: Live Agent Terminal */}
        <div className="lg:col-span-4 flex flex-col min-h-[500px]">
          <AgentActivityTerminal />
        </div>

      </div>
    </div>
  );
}
