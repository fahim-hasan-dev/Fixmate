import PDFDocument from 'pdfkit';
import { Request, Response } from 'express';
import ApiError from '../errors/ApiError';
import { StatusCodes } from 'http-status-codes';
import { Payment } from '../app/modules/payment/payment.model';
import axios from 'axios';
import { PAYMENT_STATUS } from '../enum/payment';
import { Penalty } from '../app/modules/penalty/penalty.model';

export enum USER_ROLE {
  CLIENT = 'CLIENT',
  PROVIDER = 'PROVIDER',
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum PAYMENT_TYPE {
  SERVICE_PAYMENT = 'SERVICE_PAYMENT',
  CANCELLATION_REFUND = 'CANCELLATION_REFUND',
  DISPUTE_REFUND = 'DISPUTE_REFUND',
  WITHDRAWAL = 'WITHDRAWAL',
  SETTLEMENT = 'SETTLEMENT',
}

// ─── Types ────────────────────────────────────────────────────────────────────

type PaymentData = {
  customId?: string;
  paymentType: string;
  paymentStatus: string;
  createdAt: string | Date;
  requestingRole?: string;

  // Populated relations
  customer?: { name: string; address: string; email: string };
  provider?: { name: string; email?: string; address?: string; companyName?: string };
  service?: { customId?: string; name?: string; subCategory?: string };
  serviceId?: string;

  // SERVICE_PAYMENT fields (mapped from IPayment)
  servicePrice: number;
  vat: number;
  platformFee: number;
  paystackGatewayFee: number;
  providerPay: number;

  // CANCELLATION_REFUND fields
  clientPenalty?: number;
  providerPenalty?: number;
  refundAmount?: number;
  cancellationReason?: string;

  // DISPUTE_REFUND fields
  disputeReason?: string;

  // WITHDRAWAL fields
  withdrawAmount?: number;
  withdrawalFee?: number;
  netPayout?: number;

  // SETTLEMENT fields
  settledAmount?: number;
  settlementType?: string;
};

// ─── PDF Invoice Maker ────────────────────────────────────────────────────────

export class PDFInvoiceMaker {
  private doc: any;
  private currentY: number;
  private readonly margins = 50;
  private pageWidth: number;
  private headerHeight = 65;

  constructor() {
    this.doc = new PDFDocument({ size: 'A4', margin: this.margins });
    this.currentY = this.margins;
    this.pageWidth = this.doc.page.width - this.margins * 2;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private formatCurrency(amount: number): string {
    const formatted = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
    return `R ${formatted}`;
  }

  private formatDate(date: string | Date): string {
    return new Date(date).toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private addText(
    text: string,
    options: {
      fontSize?: number;
      bold?: boolean;
      align?: 'left' | 'center' | 'right';
      color?: string;
    } = {},
  ) {
    const { fontSize = 12, bold = false, align = 'left', color = '#000000' } = options;
    this.doc
      .fontSize(fontSize)
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(color)
      .text(text, this.margins, this.currentY, { align, width: this.pageWidth });
    this.currentY += fontSize + 6;
    return this;
  }

  /**
   * Renders a line of text in a column and returns the updated Y position.
   */
  private addColumnText(
    text: string,
    x: number,
    y: number,
    width: number,
    options: { fontSize?: number; bold?: boolean; color?: string; spacing?: number } = {},
  ): number {
    const { fontSize = 11, bold = false, color = '#2c3e50', spacing = 6 } = options;
    this.doc
      .fontSize(fontSize)
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(color)
      .text(text, x, y, { width });
    return y + this.doc.heightOfString(text, { width }) + spacing;
  }

  private addSectionHeader(title: string) {
    this.addText(title, { fontSize: 13, bold: true, color: '#2c3e50' });
    this.currentY += 3;
    return this;
  }

  private addHorizontalLine() {
    this.doc
      .moveTo(this.margins, this.currentY)
      .lineTo(this.margins + this.pageWidth, this.currentY)
      .strokeColor('#e0e0e0')
      .lineWidth(1)
      .stroke();
    this.currentY += 15;
    return this;
  }

  private addSpacing(height = 10) {
    this.currentY += height;
    return this;
  }

  /**
   * Renders a two-column breakdown row.
   * label  → left column
   * value  → right column (right-aligned)
   */
  private addBreakdownRow(label: string, value: string, y: number, isTotal = false) {
    const col1 = this.margins;
    const col2 = this.margins + this.pageWidth / 2;
    const font = isTotal ? 'Helvetica-Bold' : 'Helvetica';

    this.doc.fontSize(12).font(font).fillColor('#2c3e50').text(label, col1, y);
    this.doc
      .fontSize(12)
      .font(font)
      .fillColor('#2c3e50')
      .text(value, col2, y, { align: 'right', width: this.pageWidth / 2 });
  }

  /**
   * Renders the large green "total" row used at the bottom of each section.
   */
  private addTotalRow(label: string, value: string) {
    const col1 = this.margins;
    const col2 = this.margins + this.pageWidth / 2;

    this.doc.fontSize(14).font('Helvetica-Bold').fillColor('#27ae60').text(label, col1, this.currentY);
    this.doc
      .fontSize(14)
      .font('Helvetica-Bold')
      .fillColor('#27ae60')
      .text(value, col2, this.currentY, { align: 'right', width: this.pageWidth / 2 });
    this.currentY += 24;
  }

  // ── Header ───────────────────────────────────────────────────────────────

  private async drawHeader() {
    const headerY = this.currentY;
    const logoUrl = 'https://i.ibb.co.com/Lzs2kqSn/Image20260314205009.png';

    try {
      const response = await axios.get(logoUrl, { responseType: 'arraybuffer' });
      const logoBuffer = Buffer.from(response.data);
      this.doc.image(logoBuffer, this.margins, headerY - 15, { fit: [200, 80] });
    } catch {
      this.doc.fontSize(24).font('Helvetica-Bold').fillColor('#0062EB').text('FIXMATE-SA', this.margins, headerY);
    }

    this.doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#7f8c8d')
      .text(`Generated: ${this.formatDate(new Date())}`, this.margins, headerY + 15, {
        align: 'right',
        width: this.pageWidth,
      });

    this.currentY = headerY + this.headerHeight + 10;
    this.addHorizontalLine();
  }

  // ── Main content builder ─────────────────────────────────────────────────

  private async generatePDFContent(data: PaymentData) {
    await this.drawHeader();

    // Title block
    this.addText('PAYMENT RECEIPT', { fontSize: 20, bold: true, align: 'center', color: '#0062EB' });
    this.addSpacing(1);
    this.addText('Thank you for choosing FIXMATE-SA', { fontSize: 11, align: 'center', color: '#7f8c8d' });
    this.addSpacing(8);
    this.addHorizontalLine();

    // ── Two-column info block ────────────────────────────────────────────
    const leftColX = this.margins;
    const rightColX = this.margins + this.pageWidth / 2;
    const infoStartY = this.currentY;
    const colWidth = this.pageWidth / 2 - 10;

    // Left: payment information
    let leftY = infoStartY;
    leftY = this.addColumnText('PAYMENT INFORMATION', leftColX, leftY, colWidth, { fontSize: 13, bold: true, color: '#0062EB' });
    leftY = this.addColumnText(`Invoice ID: ${data.customId || 'N/A'}`, leftColX, leftY, colWidth);

    // Conditional color for status
    const status = (data.paymentStatus || 'N/A').toUpperCase();
    let statusColor = '#2c3e50'; // default dark blue/grey
    if (status === 'PAID') statusColor = '#27ae60'; // Green
    else if (status.includes('REFUNDED') || status.includes('CANCEL')) statusColor = '#e74c3c'; // Red
    else if (status.includes('PENDING')) statusColor = '#f39c12'; // Orange

    this.doc.fontSize(11).font('Helvetica').fillColor('#2c3e50')
      .text('Status: ', leftColX, leftY, { continued: true, width: colWidth })
      .fillColor(statusColor).text(status);
    leftY += this.doc.heightOfString(`Status: ${status}`, { width: colWidth }) + 6;

    // Right: customer information
    let customerRightY = infoStartY;
    if (data.customer) {
      customerRightY = this.addColumnText('CUSTOMER INFORMATION', rightColX, customerRightY, colWidth, { fontSize: 13, bold: true, color: '#0062EB' });
      customerRightY = this.addColumnText(`Name: ${data.customer.name}`, rightColX, customerRightY, colWidth);
      customerRightY = this.addColumnText(`Email: ${data.customer.email}`, rightColX, customerRightY, colWidth);
      customerRightY = this.addColumnText(`Address: ${data.customer.address}`, rightColX, customerRightY, colWidth);
    }

    this.currentY = Math.max(leftY, customerRightY) + 8;
    this.addHorizontalLine();

    // ── Provider Information Block ────────────────────────────────────────
    if (data.provider) {
      const providerStartY = this.currentY;
      const providerRightColX = this.margins + this.pageWidth / 2;

      // Left: provider info
      let providerLeftY = providerStartY;
      providerLeftY = this.addColumnText('PROVIDER INFORMATION', leftColX, providerLeftY, colWidth, { fontSize: 13, bold: true, color: '#0062EB' });
      providerLeftY = this.addColumnText(`Name: ${data.provider.name}`, leftColX, providerLeftY, colWidth);
      if (data.provider.email) {
        providerLeftY = this.addColumnText(`Email: ${data.provider.email}`, leftColX, providerLeftY, colWidth);
      }
      if (data.provider.companyName) {
        providerLeftY = this.addColumnText(`Company: ${data.provider.companyName}`, leftColX, providerLeftY, colWidth);
      }

      // Right: service info
      let providerRightY = providerStartY;
      if (data.service) {
        providerRightY = this.addColumnText('SERVICE INFORMATION', providerRightColX, providerRightY, colWidth, { fontSize: 13, bold: true, color: '#0062EB' });
        providerRightY = this.addColumnText(`Service Name: ${data.service.subCategory || 'N/A'}`, providerRightColX, providerRightY, colWidth);
        providerRightY = this.addColumnText(`Service ID: ${data.service.customId || data.serviceId || 'N/A'}`, providerRightColX, providerRightY, colWidth);
      }

      this.currentY = Math.max(providerLeftY, providerRightY) + 8;
      this.addHorizontalLine();
    }

    // ── Payment breakdown ────────────────────────────────────────────────
    this.addSectionHeader('PAYMENT BREAKDOWN');

    const role = (data.requestingRole || USER_ROLE.ADMIN).toUpperCase() as USER_ROLE;

    switch (data.paymentType) {
      case PAYMENT_TYPE.SERVICE_PAYMENT:
      default:
        this.renderServicePayment(data, role);
        break;

      case PAYMENT_TYPE.CANCELLATION_REFUND:
        this.renderCancellationRefund(data, role);
        break;

      case PAYMENT_TYPE.DISPUTE_REFUND:
        this.renderDisputeRefund(data);
        break;

      case PAYMENT_TYPE.WITHDRAWAL:
        this.renderWithdrawal(data);
        break;

      case PAYMENT_TYPE.SETTLEMENT:
        this.renderSettlement(data);
        break;
    }

    // Payment date
    this.addText(`Payment Date: ${this.formatDate(data.createdAt)}`, {
      fontSize: 9,
      color: '#7f8c8d',
      align: 'right',
    });

    this.addSpacing(15);
    this.addHorizontalLine();

    // Legal footer
    this.addText('VAT note: Supplier is VAT-registered. This invoice includes VAT at 15%.', {
      fontSize: 8,
      align: 'center',
      color: '#7f8c8d',
    });
    this.addText('Payment was facilitated by FixMate-SA (Pty) Ltd on behalf of the service provider.', {
      fontSize: 8,
      align: 'center',
      color: '#7f8c8d',
    });
    this.addText('FixMate-SA is not the supplier of the service.', {
      fontSize: 8,
      align: 'center',
      color: '#7f8c8d',
    });
    this.addSpacing(5);
    this.addText('FIXMATE-SA - Quality Services at Your Fingertips', {
      fontSize: 10,
      align: 'center',
      color: '#0062EB',
    });
  }

  // ── Role-based section renderers ─────────────────────────────────────────

  /**
   * SERVICE_PAYMENT
   *
   * CLIENT  → service price + VAT  → total paid by client
   * PROVIDER → service price + VAT + provider share + platform commission
   * ADMIN / SUPER_ADMIN → full breakdown including gateway fee
   */
  private renderServicePayment(data: PaymentData, role: USER_ROLE) {
    let y = this.currentY;

    if (role === USER_ROLE.CLIENT) {
      this.addBreakdownRow('Service Price', this.formatCurrency(data.servicePrice - data.vat), y);
      y += 18;
      this.addBreakdownRow('VAT (inc.)', this.formatCurrency(data.vat), y);
      y += 18;

      this.currentY = y + 8;
      this.addHorizontalLine();
      this.addTotalRow('Total', this.formatCurrency(data.servicePrice));
    } else if (role === USER_ROLE.PROVIDER) {
      this.addBreakdownRow('Service Price', this.formatCurrency(data.servicePrice - data.vat), y);
      y += 18;
      this.addBreakdownRow('VAT', this.formatCurrency(data.vat), y);
      y += 18;
      this.addBreakdownRow('Provider Share', this.formatCurrency(data.providerPay), y);
      y += 18;

      this.currentY = y + 8;
      this.addHorizontalLine();
      this.addTotalRow('Total', this.formatCurrency(data.servicePrice));
    } else {
      // Admin / Super Admin
      this.addBreakdownRow('Service Price', this.formatCurrency(data.servicePrice - data.vat), y);
      y += 18;
      this.addBreakdownRow('VAT', this.formatCurrency(data.vat), y);
      y += 18;
      this.addBreakdownRow('Provider Share', this.formatCurrency(data.providerPay), y);
      y += 18;
      this.addBreakdownRow('Platform Commission', this.formatCurrency(data.platformFee), y);
      y += 18;
      this.addBreakdownRow('Gateway Fee', this.formatCurrency(data.paystackGatewayFee), y);
      y += 18;

      this.currentY = y + 8;
      this.addHorizontalLine();
      this.addTotalRow('Total', this.formatCurrency(data.servicePrice));
    }
  }

  /**
   * CANCELLATION_REFUND
   *
   * CLIENT  → original price, client penalty, net refund to client
   * PROVIDER → original price, provider penalty, amount retained by provider
   * ADMIN   → full breakdown (both penalties + net refund)
   */
  private renderCancellationRefund(data: PaymentData, role: USER_ROLE) {
    let y = this.currentY;

    this.addBreakdownRow('Original Service Price', this.formatCurrency(data.servicePrice), y);
    y += 22;

    if (role === USER_ROLE.CLIENT || role === USER_ROLE.ADMIN || role === USER_ROLE.SUPER_ADMIN) {
      this.addBreakdownRow(
        'Client Cancellation Penalty',
        this.formatCurrency(data.clientPenalty || 0),
        y,
      );
      y += 22;
    }

    if (role === USER_ROLE.PROVIDER || role === USER_ROLE.ADMIN || role === USER_ROLE.SUPER_ADMIN) {
      this.addBreakdownRow(
        'Provider Cancellation Penalty',
        this.formatCurrency(data.providerPenalty || 0),
        y,
      );
      y += 22;
    }

    if (data.cancellationReason) {
      const reasonText = `Reason: ${data.cancellationReason}`;
      this.doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#e74c3c')
        .text(reasonText, this.margins, y, { width: this.pageWidth });
      y += this.doc.heightOfString(reasonText, { width: this.pageWidth }) + 6;
    }

    this.currentY = y + 8;
    this.addHorizontalLine();

    if (role === USER_ROLE.CLIENT) {
      // Net refund = original price - client penalty
      const clientRefund = data.servicePrice - (data.clientPenalty || 0);
      this.addTotalRow('Net Refunded to You', this.formatCurrency(Math.max(clientRefund, 0)));
    } else if (role === USER_ROLE.PROVIDER) {
      // Provider might retain partial amount after their own penalty
      const providerRetained = (data.providerPay || 0) - (data.providerPenalty || 0);
      this.addTotalRow('Amount Retained', this.formatCurrency(Math.max(providerRetained, 0)));
    } else {
      // Admin sees the actual refund sent out
      this.addTotalRow('Net Refunded Amount', this.formatCurrency(data.refundAmount || 0));
    }
  }

  /**
   * DISPUTE_REFUND
   *
   * All roles see the same info — dispute outcome affects everyone.
   */
  private renderDisputeRefund(data: PaymentData) {
    let y = this.currentY;

    this.addBreakdownRow('Original Service Price', this.formatCurrency(data.servicePrice), y);
    y += 22;

    if (data.disputeReason) {
      const reasonText = `Dispute Reason: ${data.disputeReason}`;
      this.doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#e74c3c')
        .text(reasonText, this.margins, y, { width: this.pageWidth });
      y += this.doc.heightOfString(reasonText, { width: this.pageWidth }) + 6;
    }

    this.currentY = y + 8;
    this.addHorizontalLine();
    this.addTotalRow('Net Refunded Amount', this.formatCurrency(data.refundAmount || 0));
  }

  /**
   * WITHDRAWAL  (only providers & admins ever request withdrawals)
   */
  private renderWithdrawal(data: PaymentData) {
    let y = this.currentY;

    this.addBreakdownRow('Withdrawal Request Amount', this.formatCurrency(data.withdrawAmount || 0), y);
    y += 22;
    this.addBreakdownRow('Withdrawal Processing Fee', this.formatCurrency(data.withdrawalFee || 0), y);
    y += 22;

    this.currentY = y + 8;
    this.addHorizontalLine();
    this.addTotalRow('Net Bank Payout', this.formatCurrency(data.netPayout || 0));
  }

  /**
   * SETTLEMENT  (admin-facing)
   */
  private renderSettlement(data: PaymentData) {
    let y = this.currentY;

    this.addBreakdownRow('Settlement Method', data.settlementType || 'AUTO', y);
    y += 22;

    this.currentY = y + 8;
    this.addHorizontalLine();
    this.addTotalRow('Total Settled Amount', this.formatCurrency(data.settledAmount || 0));
  }

  // ── Public API ───────────────────────────────────────────────────────────

  public async generatePDFBuffer(data: PaymentData): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        const chunks: Buffer[] = [];
        this.doc.on('data', (chunk: any) => chunks.push(chunk));
        this.doc.on('end', () => resolve(Buffer.concat(chunks)));
        this.doc.on('error', reject);
        await this.generatePDFContent(data);
        this.doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  public streamPDFToResponse(res: Response, data: PaymentData, filename = 'invoice.pdf'): void {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    this.doc.pipe(res);
    this.generatePDFContent(data).then(() => this.doc.end());
  }
}

// ─── Helper: map IPayment document → PaymentData ─────────────────────────────

function mapPaymentToData(data: any, requestingRole: string): PaymentData {
  return {
    requestingRole,
    customId: data.customId,
    paymentType: data.paymentType || PAYMENT_TYPE.SERVICE_PAYMENT,
    paymentStatus: data.paymentStatus || PAYMENT_STATUS.PAID,
    createdAt: data.createdAt || new Date(),

    serviceId: data.service?.customId || data.service?._id?.toString() || data.service?.toString() || undefined,

    customer: data.customer
      ? {
        name: data.customer.name || 'N/A',
        address: data.customer.address || 'N/A',
        email: data.customer.email || 'N/A',
      }
      : undefined,

    provider: data.provider
      ? {
        name: data.provider.name || 'N/A',
        email: data.provider.email || 'N/A',
        companyName: data.provider.providerDetails?.companyName || undefined,
      }
      : undefined,

    service: data.service && typeof data.service === 'object'
      ? {
        customId: data.service.customId || undefined,
        name: data.service.name || undefined,
        subCategory: data.service.subCategory || undefined,
      }
      : undefined,

    // Core price fields — mapped directly from IPayment
    servicePrice: data.servicePrice || 0,
    vat: data.vat || 0,
    platformFee: data.platformFee || 0,
    paystackGatewayFee: data.paystackGatewayFee || 0,
    providerPay: data.providerPay || 0,

    // Cancellation / refund fields
    clientPenalty: data.clientPenalty || 0,
    providerPenalty: data.providerPenalty || 0,
    refundAmount: data.refundAmount,
    cancellationReason: data.cancellationReason,
    disputeReason: data.disputeReason,

    // Withdrawal fields
    withdrawAmount: data.withdrawAmount,
    withdrawalFee: data.withdrawalFee,
    netPayout: data.netPayout,

    // Settlement fields
    settledAmount: data.settledAmount,
    settlementType: data.settlementType,
  };
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

export async function generateInvoiceAPI(req: Request, res: Response) {
  try {
    if (!req.params.id) {
      throw new ApiError(StatusCodes.NOT_ACCEPTABLE, 'You must provide a payment ID!');
    }

    const docs = await Payment.find({ paymentId: req.params.id }).populate(
      'customer service provider booking',
    );
    const doc = docs[0] as any;
    if (!doc) throw new ApiError(StatusCodes.NOT_FOUND, 'Payment details not found!');

    const requestingRole = (req as any).user?.role || USER_ROLE.ADMIN;

    // Fetch related penalties from the Penalty collection
    const penalties = await Penalty.find({
      booking: doc.booking?.customId
    }).lean();

    const clientPenalty = penalties.find(p => p.type === 'CLIENT')?.amount || 0;
    const providerPenalty = penalties.find(p => p.type === 'PROVIDER')?.amount || 0;

    const paymentData = mapPaymentToData(
      { ...doc.toObject(), clientPenalty, providerPenalty },
      requestingRole
    );

    const pdfMaker = new PDFInvoiceMaker();
    pdfMaker.streamPDFToResponse(res, paymentData, `invoice-${paymentData.customId || Date.now()}.pdf`);
  } catch (error) {
    console.error('Error generating PDF:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to generate PDF invoice' });
    }
  }
}

export async function generateInvoiceAsBuffer(req: any, res: Response) {
  try {
    const requestingRole = req.user?.role || USER_ROLE.ADMIN;
    const paymentData = mapPaymentToData(req.body, requestingRole);

    const pdfMaker = new PDFInvoiceMaker();
    const pdfBuffer = await pdfMaker.generatePDFBuffer(paymentData);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="invoice-${paymentData.customId || Date.now()}.pdf"`,
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ success: false, message: 'Failed to generate PDF invoice' });
  }
}

export function streamPaymentPDF(res: Response, data: any, role = USER_ROLE.ADMIN) {
  try {
    const paymentData = mapPaymentToData(data, role);
    const pdfMaker = new PDFInvoiceMaker();
    pdfMaker.streamPDFToResponse(res, paymentData, 'payment-receipt.pdf');
  } catch (error) {
    console.error('Error generating PDF:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate PDF' });
    }
  }
}