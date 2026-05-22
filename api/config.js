export default function handler(req, res) {
  res.status(200).json({
    title: '주문조회',
    storeName: process.env.STORE_NAME || '전농래미안크레시티점'
  });
}