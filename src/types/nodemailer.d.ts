declare module 'nodemailer' {
  export interface Transporter {
    sendMail(mail: Record<string, unknown>): Promise<unknown>;
    verify(): Promise<unknown>;
  }

  export function createTransport(options: Record<string, unknown>): Transporter;

  const nodemailer: {
    createTransport: typeof createTransport;
  };

  export default nodemailer;
}
