export function somaPares(nums) {
  if (!Array.isArray(nums)) throw new TypeError('Invalid input: expected an array');
  return nums.reduce((acc, n) => (Number.isInteger(n) && n % 2 === 0 ? acc + n : acc), 0);
}
