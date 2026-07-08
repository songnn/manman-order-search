export default function handler(req, res) {
  res.status(200).json({
    title: '주문조회',
    storeName: process.env.STORE_NAME || '잠원메이플자이점'
  });
}