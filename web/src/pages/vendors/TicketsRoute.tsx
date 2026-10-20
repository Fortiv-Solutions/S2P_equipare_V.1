import { TicketsListPage, TicketDetailPage } from './TicketPages';

export const InternalTickets = () => <TicketsListPage />;
export const InternalTicket = () => <TicketDetailPage />;
export const VendorTickets = () => <TicketsListPage vendor />;
export const VendorTicket = () => <TicketDetailPage vendor />;
