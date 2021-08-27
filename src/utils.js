exports.toArray = (input) => {
  if (Array.isArray(input)) {
    return input;
  }
  return [input];
};

exports.getUnique = (input) => {
  return Array.from(new Set(input));
};

exports.removeBioLinkPrefix = (input) => {
  if (input && input.startsWith('biolink:')) {
    return input.slice(8);
  }
  return input;
};

// This gets the intersection of two sets.
// Lodash _.intersection gets the intersection of two arrays.
// see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set
const intersection = (setA, setB) => {
  let resultSet = new Set()
  for (let elem of setB) {
    if (setA.has(elem)) {
      resultSet.add(elem)
    }
  }
  return resultSet
}
exports.intersection = intersection;

// see https://stackoverflow.com/a/29585704
const cartesian = (a) => { // a = array of arrays
  var i, j, l, m, a1, o = [];
  if (!a || a.length == 0) return a;

  a1 = a.splice(0, 1)[0]; // the first array of a
  a = cartesian(a);
  for (i = 0, l = a1.length; i < l; i++) {
    if (a && a.length) {
      for (j = 0, m = a.length; j < m; j++) {
        o.push([a1[i]].concat(a[j]));
      }
    } else {
      o.push([a1[i]]);
    }
  }
  return o;
}
exports.cartesian = cartesian;
