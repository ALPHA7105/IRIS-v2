
module.exports = (req, res) => {
  return res.status(200).json({
    ok: true,
    message: "IRIS API is working"
  });
};
