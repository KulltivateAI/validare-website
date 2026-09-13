'use strict';

// Legacy endpoint kept only as a non-bypass alias. All accepted writes now pass
// through the reviewed same-origin Form Shield submission proxy.
module.exports = require('./form-shield/contact');
