import type { Metadata } from 'next';
import './globals.css';
import { AppStateProvider } from '@/components/AppState';
import { MarketDataProvider } from '@/components/MarketData';
import { PortfolioProvider } from '@/components/Portfolio';
import { McpProvider } from '@/components/Mcp';
import { AgentProvider } from '@/components/Agent';
import { CandlesProvider } from '@/components/Candles';
import { OrderFlowProvider } from '@/components/OrderFlow';
import { MultiExchangeProvider } from '@/components/MultiExchange';
import { EventDetectionProvider } from '@/components/EventDetection';
import { MarketIntelProvider } from '@/components/MarketIntel';
import { MemoryProvider } from '@/components/Memory';
import { ReflectionProvider } from '@/components/Reflection';
import { DebateProvider } from '@/components/Debate';
import { SupervisorProvider } from '@/components/Supervisor';
import { AutonomousResearchProvider } from '@/components/AutonomousResearch';
import { TradingControlsProvider } from '@/components/TradingControls';
import { ExchangeAccountsProvider } from '@/components/ExchangeAccounts';
import { AgentRuntimeProvider } from '@/components/AgentRuntime';
import { MissionPlannerProvider } from '@/components/MissionPlanner';

export const metadata: Metadata = {
  title: 'QUANT// Terminal — AI Trading Workstation',
  description: 'AI trading terminal — Next.js edition',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans">
        <AgentRuntimeProvider>
        <MarketDataProvider>
          <PortfolioProvider>
            <McpProvider>
              <CandlesProvider>
                <OrderFlowProvider>
                  <MultiExchangeProvider>
                    <EventDetectionProvider>
                      <AutonomousResearchProvider>
                        <MarketIntelProvider>
                          <DebateProvider>
                            <TradingControlsProvider>
                              <ExchangeAccountsProvider>
                                <MissionPlannerProvider>
                                <SupervisorProvider>
                                  <AgentProvider>
                                    <MemoryProvider>
                                      <AppStateProvider>
                                        <ReflectionProvider>{children}</ReflectionProvider>
                                      </AppStateProvider>
                                    </MemoryProvider>
                                  </AgentProvider>
                                </SupervisorProvider>
                                </MissionPlannerProvider>
                              </ExchangeAccountsProvider>
                            </TradingControlsProvider>
                          </DebateProvider>
                        </MarketIntelProvider>
                      </AutonomousResearchProvider>
                    </EventDetectionProvider>
                  </MultiExchangeProvider>
                </OrderFlowProvider>
              </CandlesProvider>
            </McpProvider>
          </PortfolioProvider>
        </MarketDataProvider>
        </AgentRuntimeProvider>
      </body>
    </html>
  );
}
